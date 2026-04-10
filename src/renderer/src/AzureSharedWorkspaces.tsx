import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  AzureAksClusterSummary,
  AzureCostOverview,
  AzureLocationSummary,
  AzureProviderContextSnapshot,
  AzureRbacOverview,
  AzureSqlEstateOverview,
  AzureStorageAccountSummary,
  AzureSubscriptionSummary,
  AzureVirtualMachineSummary,
  ComparisonDetailField,
  ComparisonDiffRow,
  ComparisonDiffStatus,
  ComparisonFocusMode,
  ComparisonRiskLevel,
  ServiceId,
  TerraformProjectListItem,
  TerraformResourceInventoryItem
} from '@shared/types'
import {
  getAzureCostOverview,
  getAzureRbacOverview,
  getAzureSqlEstate,
  listAzureAksClusters,
  listAzureMonitorActivity,
  listAzureStorageAccounts,
  listAzureStorageBlobs,
  listAzureStorageContainers,
  listAzureSubscriptions,
  listAzureVirtualMachines,
  openExternalUrl
} from './api'
import { CollapsibleInfoPanel } from './CollapsibleInfoPanel'
import './compare.css'
import './compliance-center.css'
import './direct-resource.css'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import './gcp-session-hub.css'
import { SvcState, variantForError } from './SvcState'
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

type AzureComplianceCategory = 'security' | 'compliance' | 'operations' | 'cost'
type AzureComplianceSeverity = 'high' | 'medium' | 'low'
type AzureFindingStatus = 'open' | 'in-progress' | 'accepted-risk' | 'resolved'

type AzureFinding = {
  id: string
  severity: AzureComplianceSeverity
  category: AzureComplianceCategory
  service: string
  title: string
  description: string
  recommendedAction: string
  actionLabel?: string
  actionKind?: 'navigate' | 'terminal' | 'external'
  actionTarget?: string
}

type AzureWorkflowDraft = {
  owner: string
  status: AzureFindingStatus
  acceptedRisk: string
  snoozeUntil: string
}

const AZURE_SEVERITY_ORDER: AzureComplianceSeverity[] = ['high', 'medium', 'low']
const AZURE_CATEGORY_ORDER: AzureComplianceCategory[] = ['security', 'compliance', 'operations', 'cost']
const AZURE_STATUS_OPTIONS: AzureFindingStatus[] = ['open', 'in-progress', 'accepted-risk', 'resolved']

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

type AzureDirectCategory = 'all' | 'virtual-machine' | 'aks' | 'storage' | 'database' | 'security' | 'network' | 'other'

type AzureTrackedResource = {
  key: string
  projectId: string
  projectName: string
  workspace: string
  category: AzureDirectCategory
  type: string
  name: string
  address: string
  location: string
  resourceGroup: string
  resourceId: string
  values: Record<string, unknown>
}

function resourceDisplayName(resource: TerraformResourceInventoryItem): string {
  return stringValue(resource.values.name) || resource.name || resource.address
}

function directCategoryForType(type: string): AzureDirectCategory {
  if (type === 'azurerm_linux_virtual_machine' || type === 'azurerm_windows_virtual_machine' || type.includes('_virtual_machine_scale_set')) return 'virtual-machine'
  if (type === 'azurerm_kubernetes_cluster') return 'aks'
  if (type.startsWith('azurerm_storage_')) return 'storage'
  if (type.includes('postgresql') || type.includes('mysql') || type.includes('mssql') || type.includes('sql_')) return 'database'
  if (type.includes('network_security_group') || type.includes('key_vault') || type.includes('role_assignment') || type.includes('firewall')) return 'security'
  if (type.includes('virtual_network') || type.includes('subnet') || type.includes('public_ip') || type.includes('application_gateway') || type.includes('load_balancer')) return 'network'
  return 'other'
}

function flattenAzureResources(projects: AzureTrackedProject[]): AzureTrackedResource[] {
  return projects.flatMap((project) => project.inventory
    .filter((resource) => resource.mode === 'managed' && resource.type.startsWith('azurerm_'))
    .map((resource) => ({
      key: `${project.id}:${resource.address}`,
      projectId: project.id,
      projectName: project.name,
      workspace: project.currentWorkspace,
      category: directCategoryForType(resource.type),
      type: resource.type,
      name: resourceDisplayName(resource),
      address: resource.address,
      location: stringValue(resource.values.location) || stringValue(resource.values.primary_location) || stringValue(resource.values.region),
      resourceGroup: stringValue(resource.values.resource_group_name),
      resourceId: stringValue(resource.values.id),
      values: resource.values
    })))
}

function buildAzureResourceCommand(resource: AzureTrackedResource): string {
  if (resource.resourceId) {
    return `az resource show --ids "${resource.resourceId}" --output jsonc`
  }

  const nameFilter = resource.name ? ` --name "${resource.name}"` : ''
  const groupFilter = resource.resourceGroup ? ` --resource-group "${resource.resourceGroup}"` : ''
  return `az resource list${groupFilter}${nameFilter} --output jsonc`
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

function fmtCurrency(value: number, currency = 'USD'): string {
  return `${currency === 'TRY' ? '₺' : '$'}${value.toFixed(2)}`
}

function fmtPercent(value: number): string {
  return `${value.toFixed(1)}%`
}

type AzureOverviewData = {
  vms: AzureVirtualMachineSummary[]
  aksClusters: AzureAksClusterSummary[]
  storageAccounts: AzureStorageAccountSummary[]
  sqlEstate: AzureSqlEstateOverview | null
  rbac: AzureRbacOverview | null
  cost: AzureCostOverview | null
}

type AzureServiceTileDef = {
  key: string
  label: string
  serviceId: ServiceId
  count: number
}

function buildAzureServiceTiles(data: AzureOverviewData): AzureServiceTileDef[] {
  return [
    { key: 'vms', label: 'Virtual Machines', serviceId: 'azure-virtual-machines' as ServiceId, count: data.vms.length },
    { key: 'aks', label: 'AKS Clusters', serviceId: 'azure-aks' as ServiceId, count: data.aksClusters.length },
    { key: 'storage', label: 'Storage Accounts', serviceId: 'azure-storage-accounts' as ServiceId, count: data.storageAccounts.length },
    { key: 'sql-servers', label: 'SQL Servers', serviceId: 'azure-sql' as ServiceId, count: data.sqlEstate?.serverCount ?? 0 },
    { key: 'sql-databases', label: 'SQL Databases', serviceId: 'azure-sql' as ServiceId, count: data.sqlEstate?.databaseCount ?? 0 },
    { key: 'rbac', label: 'Role Assignments', serviceId: 'azure-rbac' as ServiceId, count: data.rbac?.assignmentCount ?? 0 }
  ].sort((a, b) => b.count - a.count)
}

function buildAzureInsights(data: AzureOverviewData): Array<{ id: string; severity: 'info' | 'warning' | 'error'; subject: string; title: string; detail: string; action?: string }> {
  const items: Array<{ id: string; severity: 'info' | 'warning' | 'error'; subject: string; title: string; detail: string; action?: string }> = []

  if (data.rbac && data.rbac.riskyAssignmentCount > 0) {
    items.push({
      id: 'risky-rbac',
      severity: 'warning',
      subject: 'RBAC',
      title: `${data.rbac.riskyAssignmentCount} risky role assignments detected`,
      detail: 'Review overly permissive or wildcard role assignments to reduce blast radius.',
      action: 'Open RBAC'
    })
  }

  const publicVms = data.vms.filter((vm) => vm.hasPublicIp)
  if (publicVms.length > 0) {
    items.push({
      id: 'public-vms',
      severity: 'warning',
      subject: 'Compute',
      title: `${publicVms.length} virtual machine${publicVms.length > 1 ? 's' : ''} with public IP addresses`,
      detail: 'Public-facing VMs increase attack surface. Verify each needs direct internet exposure.'
    })
  }

  const publicStorageAccounts = data.storageAccounts.filter((sa) => sa.allowBlobPublicAccess)
  if (publicStorageAccounts.length > 0) {
    items.push({
      id: 'public-storage',
      severity: 'error',
      subject: 'Storage',
      title: `${publicStorageAccounts.length} storage account${publicStorageAccounts.length > 1 ? 's' : ''} allow public blob access`,
      detail: 'Public blob access can expose sensitive data. Disable unless explicitly required.'
    })
  }

  const publicSqlServers = data.sqlEstate?.publicServerCount ?? 0
  if (publicSqlServers > 0) {
    items.push({
      id: 'public-sql',
      severity: 'warning',
      subject: 'Database',
      title: `${publicSqlServers} SQL server${publicSqlServers > 1 ? 's' : ''} with public network access`,
      detail: 'Consider restricting network access to private endpoints for production databases.'
    })
  }

  if (data.aksClusters.length > 0) {
    const publicClusters = data.aksClusters.filter((c) => !c.privateCluster)
    if (publicClusters.length > 0) {
      items.push({
        id: 'public-aks',
        severity: 'info',
        subject: 'AKS',
        title: `${publicClusters.length} AKS cluster${publicClusters.length > 1 ? 's' : ''} with public API server`,
        detail: 'Private clusters restrict API server access to the virtual network.'
      })
    }
  }

  const storageNoHttpsOnly = data.storageAccounts.filter((sa) => !sa.httpsOnly)
  if (storageNoHttpsOnly.length > 0) {
    items.push({
      id: 'storage-https',
      severity: 'warning',
      subject: 'Storage',
      title: `${storageNoHttpsOnly.length} storage account${storageNoHttpsOnly.length > 1 ? 's' : ''} not enforcing HTTPS`,
      detail: 'Enable HTTPS-only transfer to protect data in transit.'
    })
  }

  if (data.rbac) {
    for (const note of data.rbac.notes) {
      items.push({
        id: `rbac-note-${items.length}`,
        severity: 'info',
        subject: 'RBAC',
        title: note,
        detail: ''
      })
    }
  }

  return items
}

export function AzureOverviewConsole({
  subscriptionId,
  subscriptionLabel,
  location,
  tenantId,
  modeLabel,
  modeDetail,
  contextKey,
  refreshNonce = 0,
  canRunTerminalCommand,
  onRunTerminalCommand,
  onNavigate,
  onOpenDirectAccess
}: {
  subscriptionId: string
  subscriptionLabel: string
  location: string
  tenantId: string
  modeLabel: string
  modeDetail: string
  contextKey: string
  refreshNonce?: number
  canRunTerminalCommand: boolean
  onRunTerminalCommand: (command: string) => void
  onNavigate: (serviceId: ServiceId) => void
  onOpenDirectAccess: () => void
}) {
  const [data, setData] = useState<AzureOverviewData>({ vms: [], aksClusters: [], storageAccounts: [], sqlEstate: null, rbac: null, cost: null })
  const [loading, setLoading] = useState(false)
  const [supplementalLoading, setSupplementalLoading] = useState(false)
  const [pageError, setPageError] = useState('')
  const loadTokenRef = useRef(0)
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState({ staleAfterMs: 5 * 60 * 1000 })

  // Terraform tracked projects (kept for hybrid view)
  const { projects, loading: tfLoading, refresh: tfRefresh } = useAzureTrackedProjects(contextKey, refreshNonce)
  const tfSummary = useMemo(() => aggregateSignals(projects), [projects])

  async function loadOverview(reason: 'initial' | 'manual' | 'session' = 'manual'): Promise<void> {
    if (!subscriptionId) return

    const token = loadTokenRef.current + 1
    loadTokenRef.current = token
    setPageError('')
    beginRefresh(reason)
    setLoading(true)

    try {
      // Primary: VMs, AKS, Storage — fast parallel calls
      const [vmsResult, aksResult, storageResult] = await Promise.allSettled([
        listAzureVirtualMachines(subscriptionId, location),
        listAzureAksClusters(subscriptionId, location),
        listAzureStorageAccounts(subscriptionId, location)
      ])

      if (loadTokenRef.current !== token) return

      const vms = vmsResult.status === 'fulfilled' ? vmsResult.value : []
      const aksClusters = aksResult.status === 'fulfilled' ? aksResult.value : []
      const storageAccounts = storageResult.status === 'fulfilled' ? storageResult.value : []
      setData((current) => ({ ...current, vms, aksClusters, storageAccounts }))
      setLoading(false)

      // Supplemental: RBAC, SQL, Cost — heavier calls in background
      setSupplementalLoading(true)
      const [rbacResult, sqlResult, costResult] = await Promise.allSettled([
        getAzureRbacOverview(subscriptionId),
        getAzureSqlEstate(subscriptionId, location),
        getAzureCostOverview(subscriptionId)
      ])

      if (loadTokenRef.current !== token) return

      setData((current) => ({
        ...current,
        rbac: rbacResult.status === 'fulfilled' ? rbacResult.value : current.rbac,
        sqlEstate: sqlResult.status === 'fulfilled' ? sqlResult.value : current.sqlEstate,
        cost: costResult.status === 'fulfilled' ? costResult.value : current.cost
      }))
      completeRefresh()
      setSupplementalLoading(false)
    } catch (error) {
      if (loadTokenRef.current !== token) return
      failRefresh()
      setPageError(error instanceof Error ? error.message : String(error))
      setLoading(false)
      setSupplementalLoading(false)
    }
  }

  useEffect(() => {
    void loadOverview('session')
  }, [subscriptionId, location, refreshNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalResources = data.vms.length + data.aksClusters.length + data.storageAccounts.length
    + (data.sqlEstate?.serverCount ?? 0) + (data.sqlEstate?.databaseCount ?? 0)
  const costLabel = data.cost ? fmtCurrency(data.cost.totalAmount, data.cost.currency) : '-'
  const costDetail = data.cost ? `${data.cost.timeframeLabel} · Cost Management` : 'Cost data unavailable'
  const serviceTiles = useMemo(() => buildAzureServiceTiles(data), [data])
  const insights = useMemo(() => buildAzureInsights(data), [data])

  return (
    <div className="stack azure-overview-console">
      {pageError ? <SvcState variant={variantForError(pageError)} error={pageError} /> : null}

      {/* ── Hero section (matches AWS overview-hero-card) ──────── */}
      <section className="overview-surface">
        <div className="overview-hero-card">
          <div className="overview-hero-copy">
            <div className="eyebrow">Subscription posture</div>
            <h3>{subscriptionLabel || subscriptionId || 'Azure Overview'}</h3>
            <p>
              {modeDetail || 'Cost, inventory, security posture, and insight signals for the active Azure subscription.'}
            </p>
            <div className="overview-meta-strip">
              <div className="overview-meta-pill">
                <span>Monthly cost</span>
                <strong>{costLabel}</strong>
              </div>
              <div className="overview-meta-pill">
                <span>Location</span>
                <strong>{location || 'global'}</strong>
              </div>
              <div className="overview-meta-pill">
                <span>Tenant</span>
                <strong>{tenantId ? tenantId.slice(0, 13) + '…' : '-'}</strong>
              </div>
            </div>
          </div>
          <div className="overview-hero-stats">
            <div className="overview-glance-card overview-glance-card-accent" style={{ '--accent': 'rgb(56, 139, 253)' } as React.CSSProperties}>
              <span>Cost posture</span>
              <strong>{costLabel}</strong>
              <small>{costDetail}</small>
            </div>
            <div className="overview-glance-card">
              <span>Total resources</span>
              <strong>{totalResources}</strong>
              <small>Active subscription</small>
            </div>
            <div className="overview-glance-card">
              <span>RBAC assignments</span>
              <strong>{data.rbac?.assignmentCount ?? 0}</strong>
              <small>{data.rbac ? `${data.rbac.riskyAssignmentCount} risky` : 'Loading...'}</small>
            </div>
            <div className="overview-glance-card">
              <span>Insights</span>
              <strong>{insights.length}</strong>
              <small>Generated findings</small>
            </div>
          </div>
        </div>

        {loading && <SvcState variant="loading" resourceName="Azure subscription overview" compact />}

        {supplementalLoading && (
          <SvcState variant="loading" message="Loading RBAC, SQL estate, and cost analysis in the background..." compact />
        )}

        {/* ── Account & subscription context (matches AWS Account section) ── */}
        {!loading && (
          <>
            <div className="overview-section-title">Subscription And Security Posture</div>
            <section className="overview-account-grid">
              <article className="overview-account-card">
                <div className="panel-header minor"><h3>Subscription Context</h3></div>
                <div className="overview-account-kv">
                  <div><span>Subscription</span><strong>{subscriptionLabel || subscriptionId}</strong></div>
                  <div><span>Subscription ID</span><strong>{subscriptionId}</strong></div>
                  <div><span>Tenant</span><strong>{tenantId || '-'}</strong></div>
                  <div><span>Location lens</span><strong>{location || 'global'}</strong></div>
                </div>
              </article>

              <article className="overview-account-card">
                <div className="panel-header minor">
                  <h3>RBAC Summary</h3>
                  <span className="hero-path" style={{ margin: 0 }}>{data.rbac ? `${data.rbac.principalCount} principals` : 'Loading...'}</span>
                </div>
                {data.rbac ? (
                  <div className="overview-account-kv">
                    <div><span>Total assignments</span><strong>{data.rbac.assignmentCount}</strong></div>
                    <div><span>Distinct roles</span><strong>{data.rbac.roleCount}</strong></div>
                    <div><span>Risky assignments</span><strong>{data.rbac.riskyAssignmentCount}</strong></div>
                    <div><span>Inherited</span><strong>{data.rbac.inheritedAssignmentCount}</strong></div>
                  </div>
                ) : (
                  <SvcState variant="loading" resourceName="RBAC overview" compact />
                )}
              </article>

              <article className="overview-account-card">
                <div className="panel-header minor">
                  <h3>Cost Summary</h3>
                  <span className="hero-path" style={{ margin: 0 }}>{data.cost?.timeframeLabel || 'Current month'}</span>
                </div>
                {data.cost ? (
                  <>
                    <div className="overview-account-kv">
                      <div><span>Total spend</span><strong>{fmtCurrency(data.cost.totalAmount, data.cost.currency)}</strong></div>
                      <div><span>Top services</span><strong>{data.cost.topServices.length}</strong></div>
                      <div><span>Resource groups</span><strong>{data.cost.topResourceGroups.length}</strong></div>
                    </div>
                    {data.cost.topServices.length > 0 ? (
                      <div className="overview-linked-account-list">
                        {data.cost.topServices.slice(0, 5).map((entry) => (
                          <div key={entry.label} className="overview-linked-account-row">
                            <div>
                              <strong>{entry.label}</strong>
                              <span>{fmtPercent(entry.sharePercent)} of spend</span>
                            </div>
                            <strong>{fmtCurrency(entry.amount, entry.currency)}</strong>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <SvcState variant="loading" resourceName="cost overview" compact />
                )}
              </article>
            </section>
          </>
        )}

        {/* ── Capability Hints (matches AWS) ──────────────────── */}
        {insights.length > 0 && (
          <>
            <div className="overview-section-title">Capability Hints</div>
            <section className="overview-hint-grid">
              {insights.map((hint) => (
                <article key={hint.id} className={`overview-hint-card ${hint.severity}`}>
                  <span className="overview-hint-kicker">{hint.subject}</span>
                  <strong>{hint.title}</strong>
                  <p>{hint.detail}</p>
                </article>
              ))}
            </section>
          </>
        )}

        {/* ── Cost by resource group (matches AWS Cost Ownership) ── */}
        {data.cost && data.cost.topResourceGroups.length > 0 && (
          <>
            <div className="overview-section-title">Cost By Resource Group</div>
            <section className="overview-ownership-grid">
              <article className="overview-ownership-card">
                <div className="overview-ownership-header">
                  <div>
                    <span>Resource Groups</span>
                    <strong>{fmtCurrency(data.cost.totalAmount, data.cost.currency)} total</strong>
                  </div>
                </div>
                <div className="overview-ownership-values">
                  {data.cost.topResourceGroups.slice(0, 8).map((entry) => (
                    <div key={entry.label} className="overview-ownership-value">
                      <div>
                        <strong>{entry.label}</strong>
                        <span>{fmtPercent(entry.sharePercent)} of total spend</span>
                      </div>
                      <strong>{fmtCurrency(entry.amount, entry.currency)}</strong>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          </>
        )}

        {/* ── Top Services tiles (matches AWS) ─────────────────── */}
        {!loading && (
          <>
            <div className="overview-section-title">Top Services</div>
            <section className="overview-tiles overview-tiles-featured">
              {serviceTiles.slice(0, 6).map((tile, index) => (
                <button
                  key={tile.key}
                  type="button"
                  className={`overview-tile clickable ${index === 0 ? 'highlight' : ''}`}
                  onClick={() => onNavigate(tile.serviceId)}
                  style={index === 0 ? { '--accent': 'rgb(56, 139, 253)' } as React.CSSProperties : undefined}
                >
                  <span className="overview-tile-kicker">Service</span>
                  <strong>{tile.count}</strong>
                  <span>{tile.label}</span>
                </button>
              ))}
            </section>
          </>
        )}

        {/* ── Platform Summary tiles (matches AWS) ─────────────── */}
        {!loading && (
          <>
            <div className="overview-section-title">Platform Summary</div>
            <section className="overview-tiles overview-tiles-summary">
              <div className="overview-tile highlight" style={{ '--accent': 'rgb(56, 139, 253)' } as React.CSSProperties}>
                <span className="overview-tile-kicker">Spend</span>
                <strong>{costLabel}</strong>
                <span>Total Monthly Cost</span>
              </div>
              <div className="overview-tile">
                <span className="overview-tile-kicker">Inventory</span>
                <strong>{totalResources}</strong>
                <span>Total Resources</span>
              </div>
              <div className="overview-tile">
                <span className="overview-tile-kicker">Security</span>
                <strong>{data.rbac?.assignmentCount ?? 0}</strong>
                <span>RBAC Assignments</span>
              </div>
              <div className="overview-tile">
                <span className="overview-tile-kicker">Compute</span>
                <strong>{data.vms.length}</strong>
                <span>Virtual Machines</span>
              </div>
              <div className="overview-tile">
                <span className="overview-tile-kicker">Containers</span>
                <strong>{data.aksClusters.length}</strong>
                <span>AKS Clusters</span>
              </div>
              <div className="overview-tile">
                <span className="overview-tile-kicker">Insights</span>
                <strong>{insights.length}</strong>
                <span>Findings</span>
              </div>
            </section>
          </>
        )}
      </section>

      {/* ── Cost bottom bar (matches AWS) ──────────────────────── */}
      {data.cost && (
        <div className="overview-bottom-row">
          <span>Current period total</span>
          <strong>{fmtCurrency(data.cost.totalAmount, data.cost.currency)} {data.cost.currency}</strong>
          <span className="overview-bottom-row-detail">{data.cost.timeframeLabel} · Azure Cost Management</span>
        </div>
      )}

      {/* ── Two-column data panels (matches AWS layout) ────────── */}
      {!loading && (
        <section className="workspace-grid">
          <div className="column stack">
            {/* Resource Breakdown table */}
            <div className="panel overview-data-panel">
              <div className="panel-header"><h3>Resource Breakdown</h3></div>
              <div className="table-grid overview-table-grid">
                <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr' }}>
                  <div>Category</div><div>VMs</div><div>AKS</div><div>Storage</div><div>SQL</div>
                </div>
                <div className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr' }}>
                  <div>{location || 'Subscription'}</div>
                  <div>{data.vms.length}</div>
                  <div>{data.aksClusters.length}</div>
                  <div>{data.storageAccounts.length}</div>
                  <div>{data.sqlEstate?.databaseCount ?? 0}</div>
                </div>
              </div>
            </div>

            {/* Cost by service table */}
            {data.cost && data.cost.topServices.length > 0 && (
              <div className="panel overview-data-panel">
                <div className="panel-header">
                  <h3>Cost by Service — {data.cost.timeframeLabel}</h3>
                  <span className="hero-path" style={{ margin: 0 }}>{fmtCurrency(data.cost.totalAmount, data.cost.currency)} {data.cost.currency}</span>
                </div>
                <div className="table-grid overview-table-grid">
                  <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1fr auto auto' }}>
                    <div>Service</div><div>Cost</div><div>%</div>
                  </div>
                  {data.cost.topServices.map((entry) => (
                    <div key={entry.label} className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '1rem' }}>
                      <div>{entry.label}</div>
                      <div style={{ textAlign: 'right' }}>{fmtCurrency(entry.amount, entry.currency)}</div>
                      <div style={{ textAlign: 'right', color: 'var(--muted)' }}>{fmtPercent(entry.sharePercent)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Terraform Projects */}
            {projects.length > 0 && (
              <div className="panel overview-data-panel">
                <div className="panel-header"><h3>Tracked Terraform Projects</h3></div>
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
              </div>
            )}
          </div>

          <div className="column stack">
            {/* Insights panel */}
            <div className="panel overview-insights-panel">
              <div className="panel-header"><h3>Insights</h3></div>
              {insights.length > 0 ? (
                <div className="overview-insights-list">
                  {insights.map((item) => (
                    <article key={item.id} className="overview-insight-item">
                      <span className={`signal-badge severity-${item.severity === 'error' ? 'high' : item.severity === 'warning' ? 'medium' : 'low'}`}>
                        {item.severity === 'error' ? 'Error' : item.severity === 'warning' ? 'Warn' : 'Info'}
                      </span>
                      <div>
                        <strong>{item.title}</strong>
                        {item.detail ? <p>{item.detail}</p> : null}
                        <small>{item.subject}</small>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <SvcState variant="empty" message="No active insights for this subscription." compact />
              )}
            </div>

            {/* VM summary table */}
            {data.vms.length > 0 && (
              <div className="panel overview-data-panel">
                <div className="panel-header"><h3>Virtual Machines</h3></div>
                <div className="table-grid overview-table-grid">
                  <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
                    <div>Name</div><div>Size</div><div>State</div><div>Public IP</div>
                  </div>
                  {data.vms.slice(0, 10).map((vm) => (
                    <div key={vm.id} className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
                      <div>{vm.name}</div>
                      <div>{vm.vmSize}</div>
                      <div>{vm.powerState}</div>
                      <div>{vm.hasPublicIp ? vm.publicIp : '-'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* AKS summary table */}
            {data.aksClusters.length > 0 && (
              <div className="panel overview-data-panel">
                <div className="panel-header"><h3>AKS Clusters</h3></div>
                <div className="table-grid overview-table-grid">
                  <div className="table-row table-head" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
                    <div>Cluster</div><div>Version</div><div>Nodes</div><div>Private</div>
                  </div>
                  {data.aksClusters.map((cluster) => (
                    <div key={cluster.id} className="table-row overview-table-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr' }}>
                      <div>{cluster.name}</div>
                      <div>{cluster.kubernetesVersion}</div>
                      <div>{cluster.nodeCount}</div>
                      <div>{cluster.privateCluster ? 'Yes' : 'No'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

export function AzureSessionHub({
  modeLabel,
  modeDetail,
  contextKey,
  subscriptionId,
  subscriptionLabel,
  tenantId,
  location,
  locationOptions,
  azureContext,
  catalogSubscriptions,
  recentSubscriptions,
  cliBusy,
  refreshNonce = 0,
  terminalReady,
  canRunTerminalCommand,
  onRefreshCatalog,
  onApplySubscription,
  onApplyLocation,
  onRunTerminalCommand,
  onOpenCompare,
  onOpenCompliance,
  onOpenDirectAccess,
  onOpenTerraform
}: {
  modeLabel: string
  modeDetail: string
  contextKey: string
  subscriptionId: string
  subscriptionLabel: string
  tenantId: string
  location: string
  locationOptions: string[]
  azureContext: AzureProviderContextSnapshot | null
  catalogSubscriptions: AzureSubscriptionSummary[]
  recentSubscriptions: AzureSubscriptionSummary[]
  cliBusy: boolean
  refreshNonce?: number
  terminalReady: boolean
  canRunTerminalCommand: boolean
  onRefreshCatalog: () => Promise<void>
  onApplySubscription: (subscriptionId: string, label: string) => void
  onApplyLocation: (location: string) => void
  onRunTerminalCommand: (command: string) => void
  onOpenCompare: () => void
  onOpenCompliance: () => void
  onOpenDirectAccess: () => void
  onOpenTerraform: () => void
}) {
  const [search, setSearch] = useState('')
  const { projects, loading: tfLoading, error: tfError, freshness: tfFreshness, refresh: tfRefresh } = useAzureTrackedProjects(contextKey, refreshNonce)
  const summary = useMemo(() => aggregateSignals(projects), [projects])
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000, initialFetchedAt: Date.now() })

  useEffect(() => {
    if (azureContext || refreshNonce > 0) {
      completeRefresh()
    }
  }, [azureContext, completeRefresh, refreshNonce])

  const activeSubscription = useMemo(
    () => catalogSubscriptions.find((entry) => entry.subscriptionId === subscriptionId) ?? null,
    [catalogSubscriptions, subscriptionId]
  )

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return projects
    return projects.filter((entry) =>
      [entry.name, entry.id, entry.currentWorkspace, ...entry.signals.locations, ...entry.signals.resourceGroups].join(' ').toLowerCase().includes(query)
    )
  }, [projects, search])

  const terminalActionDisabled = !canRunTerminalCommand || !terminalReady

  async function handleRefresh(): Promise<void> {
    beginRefresh('manual')
    try {
      await onRefreshCatalog()
      void tfRefresh('manual')
      completeRefresh()
    } catch {
      failRefresh()
    }
  }

  return (
    <div className="stack gcp-session-hub tf-console-azure">
      {tfError ? <SvcState variant="error" error={tfError} /> : null}
      {!canRunTerminalCommand ? (
        <div className="error-banner">
          Read mode active. Azure validation and `az` handoff actions are disabled on this screen.
        </div>
      ) : !terminalReady ? (
        <div className="error-banner">
          Terminal context is not ready yet. Select an Azure subscription and location first so the shared shell can inject the correct `az` environment.
        </div>
      ) : null}

      <section className="tf-shell-hero gcp-session-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">Sessions</div>
          <h2>Azure session workspace</h2>
          <p>{modeDetail || 'Bind the shared shell to a real Azure subscription and keep service pages aligned with that selection.'}</p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill"><span>Subscription</span><strong>{subscriptionLabel || subscriptionId || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Location</span><strong>{location || azureContext?.activeLocation || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Mode</span><strong>{modeLabel || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Account</span><strong>{azureContext?.activeAccountLabel || 'Not detected'}</strong></div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent"><span>Catalog subscriptions</span><strong>{catalogSubscriptions.length}</strong><small>Imported from the active Azure context</small></div>
          <div className="tf-shell-stat-card"><span>Locations</span><strong>{azureContext?.locations.length ?? 0}</strong><small>Distinct Azure locations visible</small></div>
          <div className="tf-shell-stat-card"><span>Tracked projects</span><strong>{summary.projectCount}</strong><small>azurerm Terraform projects linked</small></div>
          <div className="tf-shell-stat-card"><span>Access mode</span><strong>{canRunTerminalCommand ? 'Operator' : 'Read'}</strong><small>{canRunTerminalCommand ? 'Terminal remediation enabled' : 'Terminal remediation disabled'}</small></div>
        </div>
      </section>

      <div className="tf-shell-toolbar gcp-session-toolbar">
        <div className="tf-toolbar gcp-session-toolbar-main">
          <button type="button" className="accent" onClick={() => void handleRefresh()} disabled={cliBusy}>{cliBusy ? 'Refreshing...' : 'Refresh catalog'}</button>
          <button type="button" onClick={onOpenCompare}>Open Compare</button>
          <button type="button" onClick={onOpenCompliance}>Open Compliance</button>
          <button type="button" onClick={onOpenDirectAccess}>Open Direct Access</button>
          <button type="button" onClick={onOpenTerraform}>Open Terraform</button>
          <button type="button" className="ghost" disabled={terminalActionDisabled} onClick={() => onRunTerminalCommand('az account show --output jsonc')} title={terminalActionDisabled ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a subscription and location to prepare the terminal context') : 'az account show --output jsonc'}>Inspect in terminal</button>
        </div>
        <div className="tf-shell-status"><FreshnessIndicator freshness={freshness} label="Azure session catalog" staleLabel="Refresh catalog" /></div>
      </div>

      {!subscriptionId || !location ? (
        <SvcState variant="empty" message="Select an Azure subscription and location to complete the shared session context for Compare, Compliance, Direct Access, and terminal flows." />
      ) : null}

      <section className="overview-tiles gcp-session-overview-grid">
        <div className="overview-tile highlight"><strong>{activeSubscription?.displayName || subscriptionLabel || subscriptionId || 'Not selected'}</strong><span>Active subscription</span></div>
        <div className="overview-tile"><strong>{location || azureContext?.activeLocation || '-'}</strong><span>Active location</span></div>
        <div className="overview-tile"><strong>{azureContext?.activeTenantId ? azureContext.activeTenantId.slice(0, 13) + '…' : tenantId ? tenantId.slice(0, 13) + '…' : '-'}</strong><span>Active tenant</span></div>
        <div className="overview-tile"><strong>{azureContext?.activeAccountLabel || '-'}</strong><span>Account hint</span></div>
      </section>

      <div className="gcp-session-layout">
        <section className="panel stack gcp-session-panel">
          <div className="panel-header">
            <h3>Active Shell Context</h3>
          </div>
          <div className="gcp-session-kv-grid">
            <div className="gcp-session-kv"><span>Subscription</span><strong>{activeSubscription?.displayName || subscriptionLabel || subscriptionId || 'Not selected'}</strong></div>
            <div className="gcp-session-kv"><span>Subscription ID</span><strong>{subscriptionId || '-'}</strong></div>
            <div className="gcp-session-kv"><span>State</span><strong>{activeSubscription?.state || 'Unknown'}</strong></div>
            <div className="gcp-session-kv"><span>Account</span><strong>{azureContext?.activeAccountLabel || 'Not detected'}</strong></div>
            <div className="gcp-session-kv"><span>Tenant</span><strong>{tenantId || azureContext?.activeTenantId || 'Not set'}</strong></div>
            <div className="gcp-session-kv"><span>Cloud</span><strong>{azureContext?.cloudName || 'AzureCloud'}</strong></div>
          </div>
          <label className="field gcp-session-field">
            <span>Location</span>
            <select value={location} onChange={(event) => onApplyLocation(event.target.value)} disabled={locationOptions.length === 0}>
              {!location ? <option value="" disabled>{cliBusy ? 'Loading locations...' : 'Select location'}</option> : null}
              {locationOptions.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </label>
          <div className="gcp-session-action-row">
            <button type="button" disabled={terminalActionDisabled || !subscriptionId} onClick={() => onRunTerminalCommand(`az account show --subscription "${subscriptionId}" --output jsonc`)} title={terminalActionDisabled || !subscriptionId ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a subscription and location to prepare the terminal context') : `az account show --subscription "${subscriptionId}" --output jsonc`}>Describe subscription</button>
            <button type="button" disabled={terminalActionDisabled} onClick={() => onRunTerminalCommand('az ad signed-in-user show --output jsonc')} title={terminalActionDisabled ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a subscription and location to prepare the terminal context') : 'az ad signed-in-user show --output jsonc'}>Validate auth</button>
            <button type="button" disabled={terminalActionDisabled || !subscriptionId} onClick={() => onRunTerminalCommand(`az monitor activity-log list --subscription "${subscriptionId}" --max-events 10 --output jsonc`)} title={terminalActionDisabled || !subscriptionId ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a subscription and location to prepare the terminal context') : `az monitor activity-log list --subscription "${subscriptionId}" --max-events 10 --output jsonc`}>Read activity log</button>
          </div>
        </section>

        <section className="panel stack gcp-session-panel">
          <div className="panel-header">
            <h3>Available Subscriptions</h3>
          </div>
          {!catalogSubscriptions.length ? (
            <SvcState variant="empty" message="No Azure subscriptions were detected. Refresh the catalog after running `az login` or configuring service principal credentials." />
          ) : (
            <div className="selection-list gcp-session-selection-list">
              {catalogSubscriptions.map((sub) => {
                const isActive = sub.subscriptionId === subscriptionId

                return (
                  <article key={sub.subscriptionId} className={`selection-item gcp-session-card ${isActive ? 'active' : ''}`}>
                    <div className="gcp-session-card-header">
                      <div>
                        <strong>{sub.displayName}</strong>
                        <div className="hero-path"><span>{sub.subscriptionId}</span><span>{sub.tenantId ? `tenant: ${sub.tenantId.slice(0, 8)}…` : ''}</span></div>
                      </div>
                      <span className={`signal-badge ${isActive ? 'severity-low' : ''}`}>{isActive ? 'active' : sub.state?.toLowerCase() || 'available'}</span>
                    </div>
                    <div className="gcp-session-config-meta">
                      <span>State: {sub.state || '-'}</span>
                      <span>Auth: {sub.authorizationSource || '-'}</span>
                    </div>
                    <div className="gcp-session-card-actions">
                      <button type="button" onClick={() => onApplySubscription(sub.subscriptionId, sub.displayName)}>{isActive ? 'Selected' : 'Use subscription'}</button>
                      <button type="button" className="ghost" disabled={terminalActionDisabled} onClick={() => onRunTerminalCommand(`az account set --subscription "${sub.subscriptionId}"`)} title={terminalActionDisabled ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a subscription and location to prepare the terminal context') : `az account set --subscription "${sub.subscriptionId}"`}>Set in terminal</button>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <section className="panel stack gcp-session-panel">
        <div className="panel-header">
          <h3>Project Handoff Queue</h3>
        </div>
        <div className="gcp-session-project-toolbar">
          <label className="field gcp-session-search">
            <span>Search</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Project name, location, resource group" />
          </label>
        </div>
        {recentSubscriptions.length ? (
          <div className="gcp-session-recent-row">
            {recentSubscriptions.slice(0, 4).map((sub) => (
              <button key={`recent-${sub.subscriptionId}`} type="button" className={`gcp-session-recent-chip ${sub.subscriptionId === subscriptionId ? 'active' : ''}`} onClick={() => onApplySubscription(sub.subscriptionId, sub.displayName)}>
                {sub.displayName || sub.subscriptionId}
              </button>
            ))}
          </div>
        ) : null}
        {tfLoading && projects.length === 0 ? <SvcState variant="loading" resourceName="Azure Terraform projects" /> : null}
        {!tfLoading && projects.length === 0 ? <ProjectEmptyState modeLabel={modeLabel} /> : null}
        {filteredProjects.length === 0 && projects.length > 0 ? (
          <SvcState variant="no-filter-matches" resourceName="projects" />
        ) : null}
        {filteredProjects.length > 0 ? (
          <div className="gcp-session-project-grid">
            {filteredProjects.slice(0, 12).map((project) => (
              <article key={project.id} className={`gcp-session-project-card ${project.signals.isDirty ? '' : ''}`}>
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
                <div className="gcp-session-card-actions">
                  <button type="button" className="ghost" onClick={onOpenCompare}>Compare</button>
                  <button type="button" className="ghost" onClick={onOpenDirectAccess}>Direct Access</button>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}

type AzureCompareSnapshot = { subscriptionId: string; subscriptionLabel: string; location: string; rbac: AzureRbacOverview | null; vms: AzureVirtualMachineSummary[] | null; aks: AzureAksClusterSummary[] | null; storage: AzureStorageAccountSummary[] | null; sql: AzureSqlEstateOverview | null; cost: AzureCostOverview | null; errors: Partial<Record<string, string>> }
type AzureCompareRow = ComparisonDiffRow & { sectionLabel: string }
const AZURE_COMPARE_FOCUS: Array<{ value: ComparisonFocusMode; label: string }> = [{ value: 'all', label: 'All' }, { value: 'security', label: 'Security' }, { value: 'compute', label: 'Compute' }, { value: 'networking', label: 'Networking' }, { value: 'storage', label: 'Storage' }, { value: 'drift-compliance', label: 'Drift / Compliance' }, { value: 'cost', label: 'Cost' }]
function azCmpDetail(key: string, label: string, lv: string | number | boolean, rv: string | number | boolean): ComparisonDetailField { const l = typeof lv === 'boolean' ? (lv ? 'Yes' : 'No') : String(lv ?? '-'); const r = typeof rv === 'boolean' ? (rv ? 'Yes' : 'No') : String(rv ?? '-'); return { key, label, status: l === r ? 'same' : 'different', leftValue: l, rightValue: r } }
function azCmpStatus(fields: ComparisonDetailField[]): ComparisonDiffStatus { return fields.every((f) => f.status === 'same') ? 'same' : 'different' }
async function captureAz<T>(promise: Promise<T>): Promise<{ data: T | null; error: string }> { try { return { data: await promise, error: '' } } catch (e) { return { data: null, error: e instanceof Error ? e.message : String(e) } } }

async function loadAzCmpSnapshot(subId: string, subLabel: string, loc: string): Promise<AzureCompareSnapshot> {
  const [rbac, vms, aks, storage, sql, cost] = await Promise.all([captureAz(getAzureRbacOverview(subId)), captureAz(listAzureVirtualMachines(subId, loc)), captureAz(listAzureAksClusters(subId, loc)), captureAz(listAzureStorageAccounts(subId, loc)), captureAz(getAzureSqlEstate(subId, loc)), captureAz(getAzureCostOverview(subId))])
  return { subscriptionId: subId, subscriptionLabel: subLabel, location: loc, rbac: rbac.data, vms: vms.data, aks: aks.data, storage: storage.data, sql: sql.data, cost: cost.data, errors: { ...(rbac.error ? { rbac: rbac.error } : {}), ...(vms.error ? { vms: vms.error } : {}), ...(aks.error ? { aks: aks.error } : {}), ...(storage.error ? { storage: storage.error } : {}), ...(sql.error ? { sql: sql.error } : {}), ...(cost.error ? { cost: cost.error } : {}) } }
}

function mkAzRow(id: string, layer: AzureCompareRow['layer'], sec: string, title: string, sub: string, risk: ComparisonRiskLevel, svc: ServiceId, resType: string, focus: ComparisonFocusMode[], rat: string, lv: string, ls: string, rv: string, rs: string, fields: ComparisonDetailField[], subId: string, loc: string): AzureCompareRow {
  return { id, layer, section: sec, sectionLabel: sec, title, subtitle: sub, status: azCmpStatus(fields), risk, serviceId: svc, resourceType: resType, identityKey: id, normalizedIdentity: { providerId: 'azure', serviceId: svc, resourceType: resType, canonicalType: `azure:${resType.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, identityKey: id, displayName: title, locationId: loc, scopeId: subId }, focusModes: focus, rationale: rat, left: { value: lv, secondary: ls }, right: { value: rv, secondary: rs }, detailFields: fields, navigation: { providerId: 'azure', serviceId: svc, region: loc, resourceLabel: subId } }
}

function buildAzCmpRows(left: AzureCompareSnapshot, right: AzureCompareSnapshot): AzureCompareRow[] {
  const lVms = left.vms ?? [], rVms = right.vms ?? [], lAks = left.aks ?? [], rAks = right.aks ?? []
  const lStor = left.storage ?? [], rStor = right.storage ?? []
  const lPubVm = lVms.filter((v) => v.hasPublicIp).length, rPubVm = rVms.filter((v) => v.hasPublicIp).length
  const lStorRisk = lStor.filter((s) => s.allowBlobPublicAccess || !s.httpsOnly || s.minimumTlsVersion < 'TLS1_2').length
  const rStorRisk = rStor.filter((s) => s.allowBlobPublicAccess || !s.httpsOnly || s.minimumTlsVersion < 'TLS1_2').length
  const fc = (a: number | undefined, c: string | undefined) => a != null ? `${c ?? ''} ${a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim() : '-'
  return [
    mkAzRow(`az-cmp:rbac:${left.subscriptionId}:${right.subscriptionId}`, 'posture', 'RBAC', 'RBAC posture', `${left.subscriptionLabel} vs ${right.subscriptionLabel}`, left.errors.rbac || right.errors.rbac || (left.rbac?.riskyAssignmentCount ?? 0) > 0 || (right.rbac?.riskyAssignmentCount ?? 0) > 0 ? 'high' : 'low', 'azure-rbac', 'RBAC Overview', ['security', 'drift-compliance'], left.errors.rbac || right.errors.rbac ? `RBAC load was partial. Left: ${left.errors.rbac ?? 'ok'}. Right: ${right.errors.rbac ?? 'ok'}.` : 'Compares role assignments, principal spread, risky assignments, and inherited bindings.', `${left.rbac?.assignmentCount ?? 0} assignments`, `${left.rbac?.riskyAssignmentCount ?? 0} risky | ${left.rbac?.principalCount ?? 0} principals`, `${right.rbac?.assignmentCount ?? 0} assignments`, `${right.rbac?.riskyAssignmentCount ?? 0} risky | ${right.rbac?.principalCount ?? 0} principals`, [azCmpDetail('assignments', 'Total assignments', left.rbac?.assignmentCount ?? 0, right.rbac?.assignmentCount ?? 0), azCmpDetail('principals', 'Principals', left.rbac?.principalCount ?? 0, right.rbac?.principalCount ?? 0), azCmpDetail('roles', 'Distinct roles', left.rbac?.roleCount ?? 0, right.rbac?.roleCount ?? 0), azCmpDetail('risky', 'Risky assignments', left.rbac?.riskyAssignmentCount ?? 0, right.rbac?.riskyAssignmentCount ?? 0), azCmpDetail('inherited', 'Inherited assignments', left.rbac?.inheritedAssignmentCount ?? 0, right.rbac?.inheritedAssignmentCount ?? 0)], left.subscriptionId, left.location),
    mkAzRow(`az-cmp:vms:${left.subscriptionId}:${right.subscriptionId}`, 'inventory', 'Virtual Machines', 'VM fleet', `${left.location} vs ${right.location}`, left.errors.vms || right.errors.vms || lPubVm > 0 || rPubVm > 0 ? 'high' : lVms.length !== rVms.length ? 'medium' : 'low', 'azure-virtual-machines', 'VM Inventory', ['compute'], left.errors.vms || right.errors.vms ? `VM inventory load was partial. Left: ${left.errors.vms ?? 'ok'}. Right: ${right.errors.vms ?? 'ok'}.` : 'Compares instance volume, running state, public exposure, and OS distribution.', `${lVms.length} VMs`, `${lVms.filter((v) => v.powerState === 'running').length} running | ${lPubVm} public`, `${rVms.length} VMs`, `${rVms.filter((v) => v.powerState === 'running').length} running | ${rPubVm} public`, [azCmpDetail('vms', 'Virtual machines', lVms.length, rVms.length), azCmpDetail('running', 'Running', lVms.filter((v) => v.powerState === 'running').length, rVms.filter((v) => v.powerState === 'running').length), azCmpDetail('public', 'Public IP VMs', lPubVm, rPubVm), azCmpDetail('os_types', 'OS types', new Set(lVms.map((v) => v.osType)).size, new Set(rVms.map((v) => v.osType)).size), azCmpDetail('sizes', 'VM sizes', new Set(lVms.map((v) => v.vmSize)).size, new Set(rVms.map((v) => v.vmSize)).size)], left.subscriptionId, left.location),
    mkAzRow(`az-cmp:aks:${left.subscriptionId}:${right.subscriptionId}`, 'inventory', 'AKS', 'AKS cluster estate', `${left.location} vs ${right.location}`, left.errors.aks || right.errors.aks || lAks.some((c) => c.provisioningState !== 'Succeeded') || rAks.some((c) => c.provisioningState !== 'Succeeded') ? 'high' : 'low', 'azure-aks', 'AKS Inventory', ['compute', 'drift-compliance'], left.errors.aks || right.errors.aks ? `AKS inventory load was partial. Left: ${left.errors.aks ?? 'ok'}. Right: ${right.errors.aks ?? 'ok'}.` : 'Surfaces cluster count, provisioning health, version spread, and network plugin differences.', `${lAks.length} clusters`, `${lAks.reduce((s, c) => s + c.nodeCount, 0)} nodes | ${new Set(lAks.map((c) => c.kubernetesVersion)).size} versions`, `${rAks.length} clusters`, `${rAks.reduce((s, c) => s + c.nodeCount, 0)} nodes | ${new Set(rAks.map((c) => c.kubernetesVersion)).size} versions`, [azCmpDetail('clusters', 'Clusters', lAks.length, rAks.length), azCmpDetail('nodes', 'Total nodes', lAks.reduce((s, c) => s + c.nodeCount, 0), rAks.reduce((s, c) => s + c.nodeCount, 0)), azCmpDetail('private', 'Private clusters', lAks.filter((c) => c.privateCluster).length, rAks.filter((c) => c.privateCluster).length), azCmpDetail('versions', 'K8s versions', new Set(lAks.map((c) => c.kubernetesVersion)).size, new Set(rAks.map((c) => c.kubernetesVersion)).size), azCmpDetail('network_plugins', 'Network plugins', new Set(lAks.map((c) => c.networkPlugin)).size, new Set(rAks.map((c) => c.networkPlugin)).size)], left.subscriptionId, left.location),
    mkAzRow(`az-cmp:storage:${left.subscriptionId}:${right.subscriptionId}`, 'inventory', 'Storage', 'Storage account governance', `${left.location} vs ${right.location}`, left.errors.storage || right.errors.storage || lStorRisk > 0 || rStorRisk > 0 ? 'high' : 'low', 'azure-storage-accounts', 'Storage Inventory', ['storage', 'security'], left.errors.storage || right.errors.storage ? `Storage inventory load was partial. Left: ${left.errors.storage ?? 'ok'}. Right: ${right.errors.storage ?? 'ok'}.` : 'Shows storage account counts, versioning, HTTPS enforcement, TLS posture, and public access flags.', `${lStor.length} accounts`, `${lStor.filter((s) => s.versioningEnabled).length} versioned | ${lStorRisk} review`, `${rStor.length} accounts`, `${rStor.filter((s) => s.versioningEnabled).length} versioned | ${rStorRisk} review`, [azCmpDetail('accounts', 'Storage accounts', lStor.length, rStor.length), azCmpDetail('versioning', 'Versioning enabled', lStor.filter((s) => s.versioningEnabled).length, rStor.filter((s) => s.versioningEnabled).length), azCmpDetail('https', 'HTTPS only', lStor.filter((s) => s.httpsOnly).length, rStor.filter((s) => s.httpsOnly).length), azCmpDetail('public_blob', 'Allow blob public access', lStor.filter((s) => s.allowBlobPublicAccess).length, rStor.filter((s) => s.allowBlobPublicAccess).length), azCmpDetail('review', 'Accounts needing review', lStorRisk, rStorRisk)], left.subscriptionId, left.location),
    mkAzRow(`az-cmp:sql:${left.subscriptionId}:${right.subscriptionId}`, 'inventory', 'SQL', 'SQL estate posture', `${left.location} vs ${right.location}`, left.errors.sql || right.errors.sql || (left.sql?.publicServerCount ?? 0) > 0 || (right.sql?.publicServerCount ?? 0) > 0 ? 'high' : 'medium', 'azure-sql', 'SQL Estate', ['compute', 'drift-compliance'], left.errors.sql || right.errors.sql ? `SQL estate load was partial. Left: ${left.errors.sql ?? 'ok'}. Right: ${right.errors.sql ?? 'ok'}.` : 'Highlights server and database volume, public endpoint exposure, and fleet scale differences.', `${left.sql?.serverCount ?? 0} servers`, `${left.sql?.databaseCount ?? 0} databases | ${left.sql?.publicServerCount ?? 0} public`, `${right.sql?.serverCount ?? 0} servers`, `${right.sql?.databaseCount ?? 0} databases | ${right.sql?.publicServerCount ?? 0} public`, [azCmpDetail('servers', 'SQL servers', left.sql?.serverCount ?? 0, right.sql?.serverCount ?? 0), azCmpDetail('databases', 'Databases', left.sql?.databaseCount ?? 0, right.sql?.databaseCount ?? 0), azCmpDetail('public', 'Public servers', left.sql?.publicServerCount ?? 0, right.sql?.publicServerCount ?? 0)], left.subscriptionId, left.location),
    mkAzRow(`az-cmp:cost:${left.subscriptionId}:${right.subscriptionId}`, 'cost', 'Cost', 'Cost posture', `${left.subscriptionLabel} vs ${right.subscriptionLabel}`, left.errors.cost || right.errors.cost || !left.cost || !right.cost ? 'high' : Math.abs((left.cost?.totalAmount ?? 0) - (right.cost?.totalAmount ?? 0)) > 1000 ? 'medium' : 'low', 'azure-subscriptions', 'Cost Overview', ['cost', 'drift-compliance'], left.errors.cost || right.errors.cost ? `Cost overview load was partial. Left: ${left.errors.cost ?? 'ok'}. Right: ${right.errors.cost ?? 'ok'}.` : 'Compares current-period spend, top services, and resource group cost distribution.', fc(left.cost?.totalAmount, left.cost?.currency), `${left.cost?.topServices.length ?? 0} services | ${left.cost?.topResourceGroups.length ?? 0} resource groups`, fc(right.cost?.totalAmount, right.cost?.currency), `${right.cost?.topServices.length ?? 0} services | ${right.cost?.topResourceGroups.length ?? 0} resource groups`, [azCmpDetail('total', 'Total spend', fc(left.cost?.totalAmount, left.cost?.currency), fc(right.cost?.totalAmount, right.cost?.currency)), azCmpDetail('services', 'Top services', left.cost?.topServices.length ?? 0, right.cost?.topServices.length ?? 0), azCmpDetail('resource_groups', 'Top resource groups', left.cost?.topResourceGroups.length ?? 0, right.cost?.topResourceGroups.length ?? 0), azCmpDetail('timeframe', 'Timeframe', left.cost?.timeframeLabel ?? '-', right.cost?.timeframeLabel ?? '-'), azCmpDetail('currency', 'Currency', left.cost?.currency ?? '-', right.cost?.currency ?? '-')], left.subscriptionId, left.location)
  ]
}

function renderAzCmpCard(row: AzureCompareRow, selId: string, lLbl: string, rLbl: string, onSel: (id: string) => void) {
  return (<button key={row.id} type="button" className={`compare-inventory-card ${selId === row.id ? 'active' : ''}`} onClick={() => onSel(row.id)}><div className="compare-inventory-card-head"><div className="compare-inventory-card-copy"><strong>{row.title}</strong><span>{row.subtitle}</span></div><span className={`status-chip ${row.status}`}>{row.status}</span></div><div className="compare-inventory-card-meta"><span>{row.sectionLabel}</span><span>{row.resourceType}</span><span>Risk {row.risk}</span></div><div className="compare-compare-values"><div><small>{lLbl}</small><strong>{row.left.value}</strong><span>{row.left.secondary || '-'}</span></div><div><small>{rLbl}</small><strong>{row.right.value}</strong><span>{row.right.secondary || '-'}</span></div></div><p>{row.rationale}</p></button>)
}

export function AzureCompareWorkspace({ subscriptionId, subscriptionLabel, location, subscriptions, locations, refreshNonce = 0, onNavigate }: { subscriptionId: string; subscriptionLabel: string; location: string; subscriptions: AzureSubscriptionSummary[]; locations: string[]; refreshNonce?: number; onNavigate: (serviceId: ServiceId) => void }) {
  const subOpts = useMemo(() => { if (subscriptions.length > 0) return subscriptions; if (subscriptionId) return [{ subscriptionId, displayName: subscriptionLabel || subscriptionId, tenantId: '', state: 'Enabled', authorizationSource: '' }] as AzureSubscriptionSummary[]; return [] }, [subscriptions, subscriptionId, subscriptionLabel])
  const allLocs = useMemo(() => [...new Set([location, ...locations].filter(Boolean))], [location, locations])
  const [leftSubId, setLeftSubId] = useState(subscriptionId)
  const [rightSubId, setRightSubId] = useState(() => subOpts.find((s) => s.subscriptionId !== subscriptionId)?.subscriptionId ?? subscriptionId)
  const [leftLoc, setLeftLoc] = useState(location)
  const [rightLoc, setRightLoc] = useState(location)
  const [focusMode, setFocusMode] = useState<ComparisonFocusMode>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | ComparisonDiffStatus>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<AzureCompareRow[]>([])
  const [coverage, setCoverage] = useState<Array<{ label: string; status: 'full' | 'partial' }>>([])
  const [selectedRowId, setSelectedRowId] = useState('')
  const [generatedAt, setGeneratedAt] = useState('')
  useEffect(() => { setLeftSubId(subscriptionId); setLeftLoc(location); setRightSubId((c) => c || (subOpts.find((s) => s.subscriptionId !== subscriptionId)?.subscriptionId ?? subscriptionId)); setRightLoc((c) => c || location) }, [location, subscriptionId, subOpts])
  function sLabel(id: string): string { return subOpts.find((s) => s.subscriptionId === id)?.displayName || id }
  async function runDiff(): Promise<void> {
    setLoading(true); setError('')
    try {
      const [left, right] = await Promise.all([loadAzCmpSnapshot(leftSubId, sLabel(leftSubId), leftLoc), loadAzCmpSnapshot(rightSubId, sLabel(rightSubId), rightLoc)])
      const next = buildAzCmpRows(left, right)
      setRows(next); setCoverage(next.map((r) => ({ label: r.sectionLabel, status: r.rationale.includes('partial') ? 'partial' as const : 'full' as const })))
      setSelectedRowId(next.find((r) => r.status !== 'same')?.id ?? next[0]?.id ?? ''); setGeneratedAt(new Date().toISOString())
    } catch (e) { setRows([]); setCoverage([]); setSelectedRowId(''); setError(e instanceof Error ? e.message : String(e)) } finally { setLoading(false) }
  }
  useEffect(() => { if (subscriptionId) void runDiff() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (refreshNonce) void runDiff() }, [refreshNonce]) // eslint-disable-line react-hooks/exhaustive-deps
  const leftLabel = `${sLabel(leftSubId)} | ${leftLoc}`
  const rightLabel = `${sLabel(rightSubId)} | ${rightLoc}`
  const filtered = useMemo(() => { const q = search.trim().toLowerCase(); return rows.filter((r) => { if (focusMode !== 'all' && !r.focusModes.includes(focusMode)) return false; if (statusFilter !== 'all' && r.status !== statusFilter) return false; if (!q) return true; return [r.title, r.subtitle, r.sectionLabel, r.rationale, r.left.value, r.right.value].join(' ').toLowerCase().includes(q) }) }, [focusMode, rows, search, statusFilter])
  const selRow = filtered.find((r) => r.id === selectedRowId) ?? rows.find((r) => r.id === selectedRowId) ?? filtered[0] ?? rows[0] ?? null
  const diffCnt = filtered.filter((r) => r.status === 'different').length
  const sameCnt = filtered.filter((r) => r.status === 'same').length
  const highCnt = filtered.filter((r) => r.risk === 'high').length
  return (
    <div className="compare-console azure-compare-console">
      {error && <SvcState variant="error" error={error} />}
      <section className="compare-shell-hero">
        <div className="compare-shell-hero-copy">
          <div className="eyebrow">Compare</div>
          <h2>Cross-account drift and posture diff</h2>
          <p>Compare two Azure subscriptions side by side: RBAC posture, compute fleet, storage governance, SQL estate, and cost signals with field-level inspection.</p>
          <div className="compare-shell-meta-strip">
            <div className="compare-shell-meta-pill"><span>Left context</span><strong>{sLabel(leftSubId)} | {leftLoc}</strong></div>
            <div className="compare-shell-meta-pill"><span>Right context</span><strong>{sLabel(rightSubId)} | {rightLoc}</strong></div>
            <div className="compare-shell-meta-pill"><span>Subscriptions</span><strong>{subOpts.length}</strong></div>
            <div className="compare-shell-meta-pill"><span>Generated</span><strong>{generatedAt ? new Date(generatedAt).toLocaleString() : 'Pending'}</strong></div>
          </div>
        </div>
        <div className="compare-shell-hero-stats">
          <div className="compare-shell-stat-card compare-shell-stat-card-accent"><span>Tracked services</span><strong>{rows.length}</strong><small>RBAC, VMs, AKS, storage, SQL, and cost</small></div>
          <div className="compare-shell-stat-card"><span>Different</span><strong>{diffCnt}</strong><small>Rows with visible delta</small></div>
          <div className="compare-shell-stat-card"><span>Same</span><strong>{sameCnt}</strong><small>Rows currently aligned</small></div>
          <div className="compare-shell-stat-card"><span>High risk</span><strong>{highCnt}</strong><small>Rows needing attention</small></div>
          <div className="compare-shell-stat-card"><span>Coverage</span><strong>{coverage.filter((i) => i.status === 'full').length} / {coverage.length}</strong><small>Fully loaded service rows</small></div>
          <div className="compare-shell-stat-card"><span>Selected row</span><strong>{selRow?.title ?? 'None'}</strong><small>{selRow?.resourceType ?? 'Choose a row to inspect details'}</small></div>
        </div>
      </section>
      <section className="compare-shell-toolbar">
        <div className="compare-toolbar-main">
          <div className="compare-toolbar-copy"><span className="compare-pane-kicker">Diff controls</span><h3>Subscriptions and locations</h3></div>
          <div className="compare-context-grid">
            <label className="field"><span>Left subscription</span><select value={leftSubId} onChange={(e) => setLeftSubId(e.target.value)}>{subOpts.map((s) => <option key={s.subscriptionId} value={s.subscriptionId}>{s.displayName || s.subscriptionId}</option>)}</select></label>
            <label className="field"><span>Left location</span><select value={leftLoc} onChange={(e) => setLeftLoc(e.target.value)}>{allLocs.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
            <label className="field"><span>Right subscription</span><select value={rightSubId} onChange={(e) => setRightSubId(e.target.value)}>{subOpts.map((s) => <option key={s.subscriptionId} value={s.subscriptionId}>{s.displayName || s.subscriptionId}</option>)}</select></label>
            <label className="field"><span>Right location</span><select value={rightLoc} onChange={(e) => setRightLoc(e.target.value)}>{allLocs.map((l) => <option key={l} value={l}>{l}</option>)}</select></label>
          </div>
        </div>
        <div className="compare-toolbar-side">
          <button type="button" className="tf-toolbar-btn accent" disabled={loading} onClick={() => void runDiff()}>{loading ? 'Comparing...' : 'Run Diff'}</button>
          <div className="compare-toolbar-status"><span>Current compare</span><strong>{leftLabel} vs {rightLabel}</strong></div>
        </div>
      </section>
      {rows.length > 0 ? (
        <div className="compare-main-layout">
          <section className="compare-list-pane">
            <div className="compare-pane-head"><div><span className="compare-pane-kicker">Delta inventory</span><h3>Service-level compare rows</h3></div><span className="compare-pane-summary">{filtered.length} rows</span></div>
            <div className="compare-inventory-list">{filtered.map((r) => renderAzCmpCard(r, selectedRowId, leftLabel, rightLabel, setSelectedRowId))}</div>
            {filtered.length === 0 && <div className="compare-empty">No rows match the current filters.</div>}
          </section>
          <section className="compare-detail-pane">
            <section className="compare-filter-panel">
              <div className="compare-pane-head"><div><span className="compare-pane-kicker">Detail controls</span><h3>Filters and coverage</h3></div></div>
              <div className="overview-chip-row compare-chip-row compare-chip-row-full">{AZURE_COMPARE_FOCUS.map((o) => (<button key={o.value} type="button" className={`overview-service-chip ${focusMode === o.value ? 'active' : ''}`} onClick={() => setFocusMode(o.value)}><span>{o.label}</span></button>))}</div>
              <div className="compare-filter-grid">
                <label className="field"><span>Status</span><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | ComparisonDiffStatus)}><option value="all">All</option><option value="different">Different</option><option value="same">Same</option></select></label>
                <label className="field"><span>Search</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter compare rows" /></label>
              </div>
              <div className="compare-shell-meta-strip">{coverage.map((i) => (<div key={i.label} className="compare-shell-meta-pill"><span>{i.label}</span><strong>{i.status}</strong></div>))}</div>
            </section>
            {selRow ? (<>
              <section className="compare-detail-hero">
                <div className="compare-detail-hero-copy">
                  <div className="eyebrow">Selected diff</div><h3>{selRow.title}</h3><p>{selRow.rationale}</p>
                  <div className="compare-shell-meta-strip"><div className="compare-shell-meta-pill"><span>Section</span><strong>{selRow.sectionLabel}</strong></div><div className="compare-shell-meta-pill"><span>Status</span><strong>{selRow.status}</strong></div><div className="compare-shell-meta-pill"><span>Risk</span><strong>{selRow.risk}</strong></div><div className="compare-shell-meta-pill"><span>Service</span><strong>{selRow.serviceId}</strong></div></div>
                </div>
                <div className="compare-detail-hero-stats">
                  <div className="compare-shell-stat-card"><span>{leftLabel}</span><strong>{selRow.left.value}</strong><small>{selRow.left.secondary || '-'}</small></div>
                  <div className="compare-shell-stat-card"><span>{rightLabel}</span><strong>{selRow.right.value}</strong><small>{selRow.right.secondary || '-'}</small></div>
                  <div className="compare-shell-stat-card"><span>Resource type</span><strong className="compare-shell-stat-card-value compare-shell-stat-card-value-wrap">{selRow.resourceType}</strong><small>{selRow.subtitle}</small></div>
                  <div className="compare-shell-stat-card"><span>Navigation</span><strong className="compare-shell-stat-card-value">{selRow.navigation?.serviceId ?? 'Not linked'}</strong><small>Open the related Azure service page</small></div>
                </div>
              </section>
              <section className="compare-detail-section">
                <div className="compare-pane-head"><div><span className="compare-pane-kicker">Field comparison</span><h3>Left versus right values</h3></div>{selRow.navigation && (<button type="button" className="tf-toolbar-btn" onClick={() => onNavigate(selRow.navigation!.serviceId)}>Open {selRow.navigation.serviceId}</button>)}</div>
                <div className="table-grid">
                  <div className="table-row table-head compare-detail-grid"><div>Field</div><div>{leftLabel}</div><div>{rightLabel}</div></div>
                  {selRow.detailFields.map((f) => (<div key={f.key} className="table-row compare-detail-grid"><div>{f.label}</div><div>{f.leftValue || '-'}</div><div>{f.rightValue || '-'}</div></div>))}
                </div>
              </section>
            </>) : (<section className="compare-detail-section"><SvcState variant="no-selection" message="Select a compare row to inspect field-level differences." /></section>)}
          </section>
        </div>
      ) : (
        <section className="compare-detail-section"><SvcState variant="loading" message={loading ? 'Comparing the selected Azure subscriptions...' : 'Run the compare to load RBAC, compute, storage, SQL, and cost deltas.'} /></section>
      )}
    </div>
  )
}

export function AzureComplianceCenter({
  modeLabel,
  contextKey,
  subscriptionId = '',
  subscriptionLabel = '',
  location = '',
  refreshNonce = 0,
  canRunTerminalCommand,
  onRunTerminalCommand,
  onNavigate,
  onOpenDirectAccess
}: {
  modeLabel: string
  contextKey: string
  subscriptionId?: string
  subscriptionLabel?: string
  location?: string
  refreshNonce?: number
  canRunTerminalCommand: boolean
  onRunTerminalCommand: (command: string) => void
  onNavigate: (serviceId: ServiceId) => void
  onOpenDirectAccess: () => void
}) {
  const { projects, loading, error, freshness, refresh } = useAzureTrackedProjects(contextKey, refreshNonce)
  const findings = useMemo<AzureFinding[]>(() => {
    const items: AzureFinding[] = []
    for (const project of projects) {
      if (project.signals.hasLocalBackend) {
        items.push({
          id: `${project.id}:backend`,
          severity: 'medium',
          category: 'compliance',
          service: 'Infrastructure',
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
          category: 'security',
          service: 'Virtual Machines',
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
          category: 'operations',
          service: 'Resource Management',
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
          category: 'operations',
          service: 'Monitor',
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
          category: 'compliance',
          service: 'Infrastructure',
          title: 'Tracked repository contains uncommitted changes',
          description: `${project.name} is currently dirty in Git, which reduces confidence in drift and compliance signals.`,
          recommendedAction: 'Review the worktree before relying on this project for operator decisions.',
          actionLabel: 'Open Terraform',
          actionKind: 'navigate',
          actionTarget: 'terraform'
        })
      }
      if (project.signals.vmCount > 0 && project.signals.networkCount === 0) {
        items.push({
          id: `${project.id}:network`,
          severity: 'medium',
          category: 'security',
          service: 'Networking',
          title: 'Compute resources deployed without explicit network configuration',
          description: `${project.name} has ${project.signals.vmCount} VM(s) but no visible VNet or subnet resources in state.`,
          recommendedAction: 'Verify network isolation is configured and visible in the tracked scope.',
          actionLabel: 'Inspect network',
          actionKind: 'terminal',
          actionTarget: 'az network vnet list --output table'
        })
      }
      if (project.signals.storageCount > 0 && project.signals.securityCount === 0) {
        items.push({
          id: `${project.id}:storage-security`,
          severity: 'medium',
          category: 'security',
          service: 'Storage',
          title: 'Storage accounts exist without visible access controls',
          description: `${project.name} tracks ${project.signals.storageCount} storage account(s) but no role assignments or access policies are visible.`,
          recommendedAction: 'Review storage access controls and ensure RBAC or shared access policies are properly configured.',
          actionLabel: 'List storage',
          actionKind: 'terminal',
          actionTarget: 'az storage account list --output table'
        })
      }
      if (project.signals.totalResources > 10 && project.signals.sqlCount > 0 && project.signals.securityCount === 0) {
        items.push({
          id: `${project.id}:sql-security`,
          severity: 'high',
          category: 'security',
          service: 'SQL Database',
          title: 'Database resources exist without visible security controls',
          description: `${project.name} tracks ${project.signals.sqlCount} SQL resource(s) with no firewall rules or identity guardrails visible in state.`,
          recommendedAction: 'Ensure SQL firewall rules and Azure AD authentication are configured.',
          actionLabel: 'List SQL servers',
          actionKind: 'terminal',
          actionTarget: 'az sql server list --output table'
        })
      }
    }
    return items.sort((left, right) => {
      const leftRank = left.severity === 'high' ? 3 : left.severity === 'medium' ? 2 : 1
      const rightRank = right.severity === 'high' ? 3 : right.severity === 'medium' ? 2 : 1
      return rightRank - leftRank || left.title.localeCompare(right.title)
    })
  }, [projects])

  const [severityFilter, setSeverityFilter] = useState<'all' | AzureComplianceSeverity>('all')
  const [categoryFilter, setCategoryFilter] = useState<'all' | AzureComplianceCategory>('all')
  const [serviceFilter, setServiceFilter] = useState<'all' | string>('all')
  const [search, setSearch] = useState('')
  const [workflowDrafts, setWorkflowDrafts] = useState<Record<string, AzureWorkflowDraft>>({})
  const [collapsedWorkflows, setCollapsedWorkflows] = useState<Record<string, boolean>>({})
  const [copiedCommandId, setCopiedCommandId] = useState('')
  const [exportingReport, setExportingReport] = useState<'copy' | 'download' | ''>('')

  const serviceOptions = useMemo(() => (
    [...new Set(findings.map((finding) => finding.service))].sort()
  ), [findings])

  const filteredFindings = useMemo(() => {
    const query = search.trim().toLowerCase()
    return findings.filter((finding) => {
      if (severityFilter !== 'all' && finding.severity !== severityFilter) return false
      if (categoryFilter !== 'all' && finding.category !== categoryFilter) return false
      if (serviceFilter !== 'all' && finding.service !== serviceFilter) return false
      if (!query) return true
      return [finding.title, finding.description, finding.recommendedAction, finding.service, finding.category].join(' ').toLowerCase().includes(query)
    })
  }, [findings, severityFilter, categoryFilter, serviceFilter, search])

  const groupedFindings = useMemo(() => {
    const grouped = new Map<AzureComplianceSeverity, Map<AzureComplianceCategory, AzureFinding[]>>()
    for (const severity of AZURE_SEVERITY_ORDER) grouped.set(severity, new Map())
    for (const finding of filteredFindings) {
      const severityGroup = grouped.get(finding.severity) ?? new Map<AzureComplianceCategory, AzureFinding[]>()
      const categoryGroup = severityGroup.get(finding.category) ?? []
      categoryGroup.push(finding)
      severityGroup.set(finding.category, categoryGroup)
      grouped.set(finding.severity, severityGroup)
    }
    return grouped
  }, [filteredFindings])

  const topService = useMemo(() => {
    const counts = new Map<string, number>()
    for (const finding of findings) counts.set(finding.service, (counts.get(finding.service) ?? 0) + 1)
    return [...counts.entries()].sort((left, right) => right[1] - left[1])[0] ?? null
  }, [findings])

  const summary = {
    total: findings.length,
    high: findings.filter((finding) => finding.severity === 'high').length,
    medium: findings.filter((finding) => finding.severity === 'medium').length,
    low: findings.filter((finding) => finding.severity === 'low').length,
    byCategory: {
      security: findings.filter((finding) => finding.category === 'security').length,
      compliance: findings.filter((finding) => finding.category === 'compliance').length,
      operations: findings.filter((finding) => finding.category === 'operations').length,
      cost: findings.filter((finding) => finding.category === 'cost').length
    }
  }

  function workflowDraftFor(findingId: string): AzureWorkflowDraft {
    return workflowDrafts[findingId] ?? { owner: '', status: 'open', acceptedRisk: '', snoozeUntil: '' }
  }

  function patchWorkflowDraft(findingId: string, update: Partial<AzureWorkflowDraft>): void {
    setWorkflowDrafts((current) => ({
      ...current,
      [findingId]: { ...workflowDraftFor(findingId), ...update }
    }))
  }

  function isWorkflowCollapsed(findingId: string): boolean {
    return collapsedWorkflows[findingId] ?? true
  }

  function toggleWorkflowCollapsed(findingId: string): void {
    setCollapsedWorkflows((current) => ({ ...current, [findingId]: !(current[findingId] ?? true) }))
  }

  async function copyCommand(id: string, command: string): Promise<void> {
    await navigator.clipboard.writeText(command)
    setCopiedCommandId(id)
    window.setTimeout(() => setCopiedCommandId((current) => current === id ? '' : current), 1200)
  }

  function buildAzureReportMarkdown(): string {
    const lines: string[] = [
      '# Azure Compliance Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      `Context: ${subscriptionLabel || subscriptionId || modeLabel}`,
      `Location: ${location || 'global'}`,
      `Visible findings: ${filteredFindings.length} of ${summary.total}`,
      '',
      '## Summary',
      `- High: ${filteredFindings.filter((f) => f.severity === 'high').length}`,
      `- Medium: ${filteredFindings.filter((f) => f.severity === 'medium').length}`,
      `- Low: ${filteredFindings.filter((f) => f.severity === 'low').length}`,
      ''
    ]
    for (const finding of filteredFindings) {
      const draft = workflowDraftFor(finding.id)
      lines.push(`## ${finding.title}`)
      lines.push(`- Severity: ${finding.severity}`)
      lines.push(`- Category: ${finding.category}`)
      lines.push(`- Service: ${finding.service}`)
      lines.push(`- Status: ${draft.status.replace(/-/g, ' ')}`)
      lines.push(`- Owner: ${draft.owner || 'Unassigned'}`)
      if (draft.acceptedRisk) lines.push(`- Accepted Risk: ${draft.acceptedRisk}`)
      lines.push('')
      lines.push(finding.description)
      lines.push('')
      lines.push(`Recommended: ${finding.recommendedAction}`)
      lines.push('')
    }
    return lines.join('\n').trim() + '\n'
  }

  async function handleCopyReport(): Promise<void> {
    if (filteredFindings.length === 0) return
    setExportingReport('copy')
    try {
      await navigator.clipboard.writeText(buildAzureReportMarkdown())
    } finally {
      setExportingReport('')
    }
  }

  function handleDownloadReport(): void {
    if (filteredFindings.length === 0) return
    setExportingReport('download')
    try {
      const content = buildAzureReportMarkdown()
      const context = (subscriptionLabel || subscriptionId || 'azure').replace(/[^a-z0-9-_]+/gi, '-').toLowerCase()
      const stamp = new Date().toISOString().slice(0, 10)
      const filename = `azure-compliance-report-${context}-${stamp}.md`
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
    } finally {
      setExportingReport('')
    }
  }

  const scanTimestamp = freshness.fetchedAt ? new Date(freshness.fetchedAt).toLocaleString() : '-'

  return (
    <div className="stack compliance-center azure-compliance-center">
      {error ? <SvcState variant="error" error={error} /> : null}
      {!canRunTerminalCommand && findings.some((finding) => finding.actionKind === 'terminal') ? (
        <div className="error-banner">
          Read mode active. Azure CLI remediation actions are disabled on this screen.
        </div>
      ) : null}

      <section className="tf-shell-hero compliance-shell-hero">
        <div className="tf-shell-hero-copy compliance-shell-hero-copy">
          <div className="eyebrow">Compliance center</div>
          <h2>Operational findings workspace</h2>
          <p>
            Review security, compliance, operations, and cost findings in one queue with guided remediation for the active Azure context.
          </p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill">
              <span>Context</span>
              <strong>{subscriptionLabel || subscriptionId || modeLabel || 'Session context'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Location</span>
              <strong>{location || 'Global'}</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Services</span>
              <strong>{serviceOptions.length || 0} covered</strong>
            </div>
            <div className="tf-shell-meta-pill">
              <span>Projects</span>
              <strong>{projects.length} tracked</strong>
            </div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent">
            <span>Total findings</span>
            <strong>{summary.total}</strong>
            <small>{filteredFindings.length} visible in the current queue</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>High severity</span>
            <strong>{summary.high}</strong>
            <small>{filteredFindings.filter((f) => f.severity === 'high').length} high-severity items match the active filters</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Actionable</span>
            <strong>{findings.filter((f) => f.actionKind).length}</strong>
            <small>Findings with a direct remediation action</small>
          </div>
          <div className="tf-shell-stat-card">
            <span>Most affected</span>
            <strong>{topService ? topService[0] : 'Waiting'}</strong>
            <small>{topService ? `${topService[1]} findings in the current report` : 'Load a report to rank services'}</small>
          </div>
        </div>
      </section>

      <section className="overview-tiles compliance-summary-grid">
        <div className="overview-tile highlight compliance-overview-tile">
          <strong>{summary.total}</strong>
          <span>Total findings</span>
        </div>
        <div className="overview-tile compliance-overview-tile">
          <strong>{summary.high}</strong>
          <span>High severity</span>
        </div>
        <div className="overview-tile compliance-overview-tile">
          <strong>{summary.medium}</strong>
          <span>Medium severity</span>
        </div>
        <div className="overview-tile compliance-overview-tile">
          <strong>{summary.low}</strong>
          <span>Low severity</span>
        </div>
        <div className="overview-tile compliance-overview-tile">
          <strong>{scanTimestamp}</strong>
          <span>Last scan</span>
        </div>
      </section>

      <section className="panel stack compliance-panel">
        <div className="panel-header">
          <div>
            <div className="eyebrow compliance-panel-eyebrow">Category posture</div>
            <h3>Finding distribution</h3>
          </div>
          <span className="hero-path compliance-panel-summary">
            {filteredFindings.length} finding{filteredFindings.length === 1 ? '' : 's'} in the active queue
          </span>
        </div>
        <div className="compliance-category-strip">
          {AZURE_CATEGORY_ORDER.map((category) => (
            <button
              key={category}
              type="button"
              className={`compliance-category-chip ${categoryFilter === category ? 'active' : ''}`}
              onClick={() => setCategoryFilter((current) => current === category ? 'all' : category)}
            >
              <span>{category}</span>
              <strong>{summary.byCategory[category]}</strong>
            </button>
          ))}
        </div>
      </section>

      <div className="tf-shell-toolbar compliance-shell-toolbar compliance-shell-toolbar-inline">
        <div className="tf-toolbar compliance-shell-toolbar-main">
          <button type="button" className="accent" onClick={() => void refresh('manual')} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh report'}
          </button>
          <label className="field compliance-toolbar-field">
            <span>Severity</span>
            <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value as 'all' | AzureComplianceSeverity)}>
              <option value="all">All severities</option>
              {AZURE_SEVERITY_ORDER.map((severity) => (
                <option key={severity} value={severity}>{severity}</option>
              ))}
            </select>
          </label>
          <label className="field compliance-toolbar-field">
            <span>Category</span>
            <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value as 'all' | AzureComplianceCategory)}>
              <option value="all">All categories</option>
              {AZURE_CATEGORY_ORDER.map((category) => (
                <option key={category} value={category}>{category}</option>
              ))}
            </select>
          </label>
          <label className="field compliance-toolbar-field">
            <span>Service</span>
            <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}>
              <option value="all">All services</option>
              {serviceOptions.map((service) => (
                <option key={service} value={service}>{service}</option>
              ))}
            </select>
          </label>
          <label className="field compliance-toolbar-search">
            <span>Search</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Title, service, action"
            />
          </label>
          <div className="compliance-toolbar-export">
            <button
              type="button"
              className="compliance-secondary-button"
              onClick={() => void handleCopyReport()}
              disabled={filteredFindings.length === 0 || exportingReport !== ''}
            >
              {exportingReport === 'copy' ? 'Copying...' : 'Copy report'}
            </button>
            <button
              type="button"
              className="compliance-action-button"
              onClick={handleDownloadReport}
              disabled={filteredFindings.length === 0 || exportingReport !== ''}
            >
              {exportingReport === 'download' ? 'Preparing...' : 'Download report'}
            </button>
          </div>
        </div>
        <div className="tf-shell-status compliance-shell-status">
          <FreshnessIndicator freshness={freshness} label="Compliance report" staleLabel="Refresh report" />
        </div>
      </div>

      {loading && findings.length === 0 ? <SvcState variant="loading" resourceName="compliance findings" /> : null}
      {!loading && projects.length === 0 ? <ProjectEmptyState modeLabel={modeLabel} /> : null}
      {!loading && projects.length > 0 && filteredFindings.length === 0 && findings.length > 0 ? (
        <SvcState variant="no-filter-matches" resourceName="findings" />
      ) : null}
      {!loading && projects.length > 0 && findings.length === 0 ? (
        <SvcState variant="empty" message="No compliance findings are currently visible for the active Azure context." />
      ) : null}

      {AZURE_SEVERITY_ORDER.map((severity) => {
        const severityGroups = groupedFindings.get(severity)
        const severityCount = filteredFindings.filter((finding) => finding.severity === severity).length
        if (!severityGroups || severityCount === 0) return null

        return (
          <section key={severity} className={`panel stack compliance-panel compliance-severity-panel severity-${severity}`}>
            <div className="panel-header compliance-severity-header">
              <div>
                <h3>{severity.charAt(0).toUpperCase() + severity.slice(1)} Severity</h3>
              </div>
              <span className={`signal-badge severity-${severity}`}>{severityCount}</span>
            </div>

            {AZURE_CATEGORY_ORDER.map((category) => {
              const items = severityGroups.get(category) ?? []
              if (items.length === 0) return null

              return (
                <div key={`${severity}-${category}`} className="compliance-category-block">
                  <div className="compliance-category-header">
                    <h4>{category}</h4>
                    <span>{items.length} item{items.length === 1 ? '' : 's'}</span>
                  </div>
                  <div className="compliance-finding-list">
                    {items.map((finding) => {
                      const workflowDraft = workflowDraftFor(finding.id)
                      const workflowCollapsed = isWorkflowCollapsed(finding.id)

                      return (
                        <article key={finding.id} className={`compliance-finding-card severity-${finding.severity}`}>
                          <div className="compliance-finding-header">
                            <div className="compliance-finding-copy">
                              <div className="compliance-finding-badges">
                                <span className={`signal-badge severity-${finding.severity}`}>{finding.severity}</span>
                                <span className="signal-badge">{finding.category}</span>
                                <span className="signal-badge">{workflowDraft.status.replace(/-/g, ' ')}</span>
                                <span className="signal-badge">{finding.service}</span>
                              </div>
                              <h5>{finding.title}</h5>
                            </div>
                            <div className="compliance-finding-action">
                              {renderActionButton(finding, canRunTerminalCommand, onNavigate, onRunTerminalCommand)}
                            </div>
                          </div>
                          <p>{finding.description}</p>
                          <div className="compliance-next-step">
                            <span>Recommended action</span>
                            <strong>{finding.recommendedAction}</strong>
                          </div>
                          <div className="compliance-workflow-shell">
                            <div className="compliance-workflow-summary">
                              <div className="compliance-workflow-summary-item">
                                <span>Owner</span>
                                <strong>{workflowDraft.owner || 'Unassigned'}</strong>
                              </div>
                              <div className="compliance-workflow-summary-item">
                                <span>Status</span>
                                <strong>{workflowDraft.status.replace(/-/g, ' ')}</strong>
                              </div>
                              <div className="compliance-workflow-summary-item">
                                <span>Snooze Until</span>
                                <strong>{workflowDraft.snoozeUntil || 'Active'}</strong>
                              </div>
                              <div className="compliance-workflow-summary-item">
                                <span>Category</span>
                                <strong>{finding.category}</strong>
                              </div>
                            </div>
                            <div className="compliance-workflow-actions">
                              <button
                                type="button"
                                className="compliance-secondary-button"
                                onClick={() => toggleWorkflowCollapsed(finding.id)}
                              >
                                {workflowCollapsed ? 'Show Workflow' : 'Hide Workflow'}
                              </button>
                              {finding.actionTarget && finding.actionKind === 'terminal' ? (
                                <button
                                  type="button"
                                  className="compliance-secondary-button"
                                  onClick={() => void copyCommand(finding.id, finding.actionTarget!)}
                                >
                                  {copiedCommandId === finding.id ? 'Copied' : 'Copy Command'}
                                </button>
                              ) : null}
                            </div>
                          </div>
                          {!workflowCollapsed ? (
                            <div className="compliance-workflow-grid">
                              <label className="field compliance-workflow-field">
                                <span>Owner</span>
                                <input
                                  value={workflowDraft.owner}
                                  onChange={(event) => patchWorkflowDraft(finding.id, { owner: event.target.value })}
                                  placeholder="Owner or team"
                                />
                              </label>
                              <label className="field compliance-workflow-field">
                                <span>Status</span>
                                <select
                                  value={workflowDraft.status}
                                  onChange={(event) => patchWorkflowDraft(finding.id, { status: event.target.value as AzureFindingStatus })}
                                >
                                  {AZURE_STATUS_OPTIONS.map((status) => (
                                    <option key={status} value={status}>{status}</option>
                                  ))}
                                </select>
                              </label>
                              <label className="field compliance-workflow-field">
                                <span>Snooze Until</span>
                                <input
                                  type="date"
                                  value={workflowDraft.snoozeUntil}
                                  onChange={(event) => patchWorkflowDraft(finding.id, { snoozeUntil: event.target.value })}
                                />
                              </label>
                              <label className="field compliance-workflow-field compliance-workflow-notes">
                                <span>Accepted Risk</span>
                                <textarea
                                  value={workflowDraft.acceptedRisk}
                                  onChange={(event) => patchWorkflowDraft(finding.id, { acceptedRisk: event.target.value })}
                                  placeholder="Document why this finding is tolerated, if applicable"
                                  rows={2}
                                />
                              </label>
                            </div>
                          ) : null}
                        </article>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

// AzureDirectAccessWorkspace has been moved to AzureDirectAccessConsole.tsx

