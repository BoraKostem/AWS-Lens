import { useEffect, useMemo, useState } from 'react'

import type {
  ComparisonDetailField,
  ComparisonDiffRow,
  ComparisonDiffStatus,
  ComparisonFocusMode,
  ComparisonRiskLevel,
  GcpBillingOverview,
  GcpCliProject,
  GcpComputeInstanceSummary,
  GcpGkeClusterSummary,
  GcpIamOverview,
  GcpProjectOverview,
  GcpSqlInstanceSummary,
  GcpStorageBucketSummary,
  ServiceId
} from '@shared/types'
import {
  getGcpBillingOverview,
  getGcpIamOverview,
  getGcpProjectOverview,
  listGcpComputeInstances,
  listGcpGkeClusters,
  listGcpSqlInstances,
  listGcpStorageBuckets
} from './api'
import { SvcState } from './SvcState'
import './compare.css'

type Snapshot = {
  projectId: string
  location: string
  project: GcpProjectOverview | null
  iam: GcpIamOverview | null
  compute: GcpComputeInstanceSummary[] | null
  gke: GcpGkeClusterSummary[] | null
  storage: GcpStorageBucketSummary[] | null
  sql: GcpSqlInstanceSummary[] | null
  billing: GcpBillingOverview | null
  errors: Partial<Record<'projects' | 'iam' | 'compute' | 'gke' | 'storage' | 'sql' | 'billing', string>>
}

type Row = ComparisonDiffRow & { sectionLabel: string }

const FOCUS_OPTIONS: Array<{ value: ComparisonFocusMode; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'security', label: 'Security' },
  { value: 'compute', label: 'Compute' },
  { value: 'networking', label: 'Networking' },
  { value: 'storage', label: 'Storage' },
  { value: 'drift-compliance', label: 'Drift / Compliance' },
  { value: 'cost', label: 'Cost' }
]

function optionLabel(projectId: string, projects: GcpCliProject[]): string {
  const match = projects.find((entry) => entry.projectId === projectId)
  return match ? `${projectId}${match.name ? ` (${match.name})` : ''}` : projectId
}

function detail(key: string, label: string, leftValue: string | number | boolean, rightValue: string | number | boolean): ComparisonDetailField {
  const left = typeof leftValue === 'boolean' ? (leftValue ? 'Yes' : 'No') : String(leftValue ?? '-')
  const right = typeof rightValue === 'boolean' ? (rightValue ? 'Yes' : 'No') : String(rightValue ?? '-')
  return { key, label, status: left === right ? 'same' : 'different', leftValue: left, rightValue: right }
}

function status(fields: ComparisonDetailField[]): ComparisonDiffStatus {
  return fields.every((field) => field.status === 'same') ? 'same' : 'different'
}

function uniq(values: string[]): number {
  return new Set(values.filter(Boolean)).size
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function capture<T>(promise: Promise<T>): Promise<{ data: T | null; error: string }> {
  try {
    return { data: await promise, error: '' }
  } catch (error) {
    return { data: null, error: text(error) }
  }
}

async function loadSnapshot(projectId: string, location: string, catalogProjectIds: string[]): Promise<Snapshot> {
  const [project, iam, compute, gke, storage, sql, billing] = await Promise.all([
    capture(getGcpProjectOverview(projectId)),
    capture(getGcpIamOverview(projectId)),
    capture(listGcpComputeInstances(projectId, location)),
    capture(listGcpGkeClusters(projectId, location)),
    capture(listGcpStorageBuckets(projectId, location)),
    capture(listGcpSqlInstances(projectId, location)),
    capture(getGcpBillingOverview(projectId, catalogProjectIds))
  ])

  return {
    projectId,
    location,
    project: project.data,
    iam: iam.data,
    compute: compute.data,
    gke: gke.data,
    storage: storage.data,
    sql: sql.data,
    billing: billing.data,
    errors: {
      ...(project.error ? { projects: project.error } : {}),
      ...(iam.error ? { iam: iam.error } : {}),
      ...(compute.error ? { compute: compute.error } : {}),
      ...(gke.error ? { gke: gke.error } : {}),
      ...(storage.error ? { storage: storage.error } : {}),
      ...(sql.error ? { sql: sql.error } : {}),
      ...(billing.error ? { billing: billing.error } : {})
    }
  }
}

function makeRow(
  id: string,
  layer: Row['layer'],
  sectionLabel: string,
  title: string,
  subtitle: string,
  risk: ComparisonRiskLevel,
  serviceId: ServiceId,
  resourceType: string,
  focusModes: ComparisonFocusMode[],
  rationale: string,
  leftLabel: string,
  leftSecondary: string,
  rightLabel: string,
  rightSecondary: string,
  fields: ComparisonDetailField[],
  projectId: string,
  location: string
): Row {
  return {
    id,
    layer,
    section: sectionLabel,
    sectionLabel,
    title,
    subtitle,
    status: status(fields),
    risk,
    serviceId,
    resourceType,
    identityKey: id,
    normalizedIdentity: {
      providerId: 'gcp',
      serviceId,
      resourceType,
      canonicalType: `gcp:${resourceType.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      identityKey: id,
      displayName: title,
      locationId: location,
      scopeId: projectId
    },
    focusModes,
    rationale,
    left: { value: leftLabel, secondary: leftSecondary },
    right: { value: rightLabel, secondary: rightSecondary },
    detailFields: fields,
    navigation: {
      providerId: 'gcp',
      serviceId,
      region: location,
      resourceLabel: projectId
    }
  }
}

function buildRows(left: Snapshot, right: Snapshot): Row[] {
  const leftCompute = left.compute ?? []
  const rightCompute = right.compute ?? []
  const leftGke = left.gke ?? []
  const rightGke = right.gke ?? []
  const leftStorage = left.storage ?? []
  const rightStorage = right.storage ?? []
  const leftSql = left.sql ?? []
  const rightSql = right.sql ?? []
  const leftVersioned = leftStorage.filter((bucket) => bucket.versioningEnabled).length
  const rightVersioned = rightStorage.filter((bucket) => bucket.versioningEnabled).length
  const leftStorageRisk = leftStorage.filter((bucket) => bucket.publicAccessPrevention.toLowerCase() !== 'enforced' || !bucket.uniformBucketLevelAccessEnabled).length
  const rightStorageRisk = rightStorage.filter((bucket) => bucket.publicAccessPrevention.toLowerCase() !== 'enforced' || !bucket.uniformBucketLevelAccessEnabled).length
  const leftSqlPublic = leftSql.filter((instance) => Boolean(instance.primaryAddress)).length
  const rightSqlPublic = rightSql.filter((instance) => Boolean(instance.primaryAddress)).length
  const leftSqlProtected = leftSql.filter((instance) => instance.deletionProtectionEnabled).length
  const rightSqlProtected = rightSql.filter((instance) => instance.deletionProtectionEnabled).length

  return [
    makeRow(
      `gcp-compare:projects:${left.projectId}:${right.projectId}`, 'summary', 'Projects', 'Project posture', `${left.projectId} vs ${right.projectId}`,
      left.errors.projects || right.errors.projects ? 'high' : 'low', 'gcp-projects', 'Project Overview', ['all', 'drift-compliance'],
      left.errors.projects || right.errors.projects
        ? `Project overview load was partial. Left: ${left.errors.projects ?? 'ok'}. Right: ${right.errors.projects ?? 'ok'}.`
        : 'Compares lifecycle, enabled APIs, labels, and hierarchy between the selected Google Cloud projects.',
      left.project?.displayName || left.projectId, `${left.project?.enabledApiCount ?? 0} APIs | ${left.project?.labels.length ?? 0} labels`,
      right.project?.displayName || right.projectId, `${right.project?.enabledApiCount ?? 0} APIs | ${right.project?.labels.length ?? 0} labels`,
      [
        detail('lifecycle', 'Lifecycle', left.project?.lifecycleState ?? 'Unavailable', right.project?.lifecycleState ?? 'Unavailable'),
        detail('parent', 'Parent', `${left.project?.parentType ?? '-'} ${left.project?.parentId ?? ''}`.trim(), `${right.project?.parentType ?? '-'} ${right.project?.parentId ?? ''}`.trim()),
        detail('enabled_apis', 'Enabled APIs', left.project?.enabledApiCount ?? 0, right.project?.enabledApiCount ?? 0),
        detail('labels', 'Labels', left.project?.labels.length ?? 0, right.project?.labels.length ?? 0),
        detail('capability_hints', 'Capability hints', left.project?.capabilityHints.length ?? 0, right.project?.capabilityHints.length ?? 0)
      ],
      left.projectId, left.location
    ),
    makeRow(
      `gcp-compare:iam:${left.projectId}:${right.projectId}`, 'posture', 'IAM posture', 'Identity and binding posture', `${left.projectId} vs ${right.projectId}`,
      left.errors.iam || right.errors.iam || (left.iam?.publicPrincipalCount ?? 0) > 0 || (right.iam?.publicPrincipalCount ?? 0) > 0 ? 'high' : (left.iam?.riskyBindingCount ?? 0) > 0 || (right.iam?.riskyBindingCount ?? 0) > 0 ? 'medium' : 'low',
      'gcp-iam', 'IAM Overview', ['security', 'drift-compliance'],
      left.errors.iam || right.errors.iam
        ? `IAM load was partial. Left: ${left.errors.iam ?? 'ok'}. Right: ${right.errors.iam ?? 'ok'}.`
        : 'Highlights principal spread, risky bindings, and public exposure differences.',
      `${left.iam?.principalCount ?? 0} principals`, `${left.iam?.riskyBindingCount ?? 0} risky | ${left.iam?.publicPrincipalCount ?? 0} public`,
      `${right.iam?.principalCount ?? 0} principals`, `${right.iam?.riskyBindingCount ?? 0} risky | ${right.iam?.publicPrincipalCount ?? 0} public`,
      [
        detail('principals', 'Principals', left.iam?.principalCount ?? 0, right.iam?.principalCount ?? 0),
        detail('bindings', 'Bindings', left.iam?.bindingCount ?? 0, right.iam?.bindingCount ?? 0),
        detail('risky', 'Risky bindings', left.iam?.riskyBindingCount ?? 0, right.iam?.riskyBindingCount ?? 0),
        detail('public', 'Public principals', left.iam?.publicPrincipalCount ?? 0, right.iam?.publicPrincipalCount ?? 0),
        detail('service_accounts', 'Service accounts', left.iam?.serviceAccounts.length ?? 0, right.iam?.serviceAccounts.length ?? 0)
      ],
      left.projectId, left.location
    ),
    makeRow(
      `gcp-compare:compute:${left.projectId}:${right.projectId}:${left.location}:${right.location}`, 'inventory', 'Compute Engine', 'Compute Engine fleet', `${left.location} vs ${right.location}`,
      left.errors.compute || right.errors.compute ? 'high' : leftCompute.some((instance) => instance.externalIp) || rightCompute.some((instance) => instance.externalIp) ? 'medium' : 'low',
      'gcp-compute-engine', 'Compute Inventory', ['compute'],
      left.errors.compute || right.errors.compute
        ? `Compute inventory load was partial. Left: ${left.errors.compute ?? 'ok'}. Right: ${right.errors.compute ?? 'ok'}.`
        : 'Compares instance volume, running coverage, zone spread, and public exposure.',
      `${leftCompute.length} instances`, `${leftCompute.filter((instance) => instance.status === 'RUNNING').length} running | ${leftCompute.filter((instance) => instance.externalIp).length} public`,
      `${rightCompute.length} instances`, `${rightCompute.filter((instance) => instance.status === 'RUNNING').length} running | ${rightCompute.filter((instance) => instance.externalIp).length} public`,
      [
        detail('instances', 'Instances', leftCompute.length, rightCompute.length),
        detail('running', 'Running', leftCompute.filter((instance) => instance.status === 'RUNNING').length, rightCompute.filter((instance) => instance.status === 'RUNNING').length),
        detail('public', 'External IP instances', leftCompute.filter((instance) => instance.externalIp).length, rightCompute.filter((instance) => instance.externalIp).length),
        detail('zones', 'Zones represented', uniq(leftCompute.map((instance) => instance.zone)), uniq(rightCompute.map((instance) => instance.zone))),
        detail('machine_types', 'Machine types', uniq(leftCompute.map((instance) => instance.machineType)), uniq(rightCompute.map((instance) => instance.machineType)))
      ],
      left.projectId, left.location
    ),
    makeRow(
      `gcp-compare:gke:${left.projectId}:${right.projectId}:${left.location}:${right.location}`, 'inventory', 'GKE', 'Cluster estate', `${left.location} vs ${right.location}`,
      left.errors.gke || right.errors.gke ? 'high' : leftGke.some((cluster) => cluster.status !== 'RUNNING') || rightGke.some((cluster) => cluster.status !== 'RUNNING') ? 'medium' : 'low',
      'gcp-gke', 'Cluster Inventory', ['compute', 'drift-compliance'],
      left.errors.gke || right.errors.gke
        ? `GKE inventory load was partial. Left: ${left.errors.gke ?? 'ok'}. Right: ${right.errors.gke ?? 'ok'}.`
        : 'Surfaces cluster count, unhealthy posture, version spread, and release-channel drift.',
      `${leftGke.length} clusters`, `${leftGke.filter((cluster) => cluster.status !== 'RUNNING').length} non-running | ${uniq(leftGke.map((cluster) => cluster.releaseChannel))} channels`,
      `${rightGke.length} clusters`, `${rightGke.filter((cluster) => cluster.status !== 'RUNNING').length} non-running | ${uniq(rightGke.map((cluster) => cluster.releaseChannel))} channels`,
      [
        detail('clusters', 'Clusters', leftGke.length, rightGke.length),
        detail('non_running', 'Non-running clusters', leftGke.filter((cluster) => cluster.status !== 'RUNNING').length, rightGke.filter((cluster) => cluster.status !== 'RUNNING').length),
        detail('channels', 'Release channels', uniq(leftGke.map((cluster) => cluster.releaseChannel)), uniq(rightGke.map((cluster) => cluster.releaseChannel))),
        detail('locations', 'Cluster locations', uniq(leftGke.map((cluster) => cluster.location)), uniq(rightGke.map((cluster) => cluster.location))),
        detail('first_version', 'First cluster version', leftGke[0]?.masterVersion ?? '-', rightGke[0]?.masterVersion ?? '-')
      ],
      left.projectId, left.location
    ),
    makeRow(
      `gcp-compare:storage:${left.projectId}:${right.projectId}:${left.location}:${right.location}`, 'inventory', 'Cloud Storage', 'Bucket governance posture', `${left.location} vs ${right.location}`,
      left.errors.storage || right.errors.storage || leftStorageRisk > 0 || rightStorageRisk > 0 ? 'high' : 'low',
      'gcp-cloud-storage', 'Bucket Inventory', ['storage', 'security'],
      left.errors.storage || right.errors.storage
        ? `Cloud Storage inventory load was partial. Left: ${left.errors.storage ?? 'ok'}. Right: ${right.errors.storage ?? 'ok'}.`
        : 'Shows bucket counts and governance controls such as versioning, public access prevention, and uniform access.',
      `${leftStorage.length} buckets`, `${leftVersioned} versioned | ${leftStorageRisk} review`,
      `${rightStorage.length} buckets`, `${rightVersioned} versioned | ${rightStorageRisk} review`,
      [
        detail('buckets', 'Buckets', leftStorage.length, rightStorage.length),
        detail('versioning', 'Versioning enabled', leftVersioned, rightVersioned),
        detail('uniform_access', 'Uniform access enabled', leftStorage.filter((bucket) => bucket.uniformBucketLevelAccessEnabled).length, rightStorage.filter((bucket) => bucket.uniformBucketLevelAccessEnabled).length),
        detail('public_access_prevention', 'Public access prevention enforced', leftStorage.filter((bucket) => bucket.publicAccessPrevention.toLowerCase() === 'enforced').length, rightStorage.filter((bucket) => bucket.publicAccessPrevention.toLowerCase() === 'enforced').length),
        detail('review_buckets', 'Buckets needing review', leftStorageRisk, rightStorageRisk)
      ],
      left.projectId, left.location
    ),
    makeRow(
      `gcp-compare:sql:${left.projectId}:${right.projectId}:${left.location}:${right.location}`, 'inventory', 'Cloud SQL', 'Database posture', `${left.location} vs ${right.location}`,
      left.errors.sql || right.errors.sql || leftSqlPublic > 0 || rightSqlPublic > 0 || leftSqlProtected !== leftSql.length || rightSqlProtected !== rightSql.length ? 'high' : 'medium',
      'gcp-cloud-sql', 'SQL Inventory', ['compute', 'drift-compliance'],
      left.errors.sql || right.errors.sql
        ? `Cloud SQL inventory load was partial. Left: ${left.errors.sql ?? 'ok'}. Right: ${right.errors.sql ?? 'ok'}.`
        : 'Highlights instance volume, deletion protection, and public versus private connectivity differences.',
      `${leftSql.length} instances`, `${leftSqlProtected} protected | ${leftSqlPublic} public`,
      `${rightSql.length} instances`, `${rightSqlProtected} protected | ${rightSqlPublic} public`,
      [
        detail('instances', 'Instances', leftSql.length, rightSql.length),
        detail('protected', 'Deletion protection enabled', leftSqlProtected, rightSqlProtected),
        detail('public', 'Public IP endpoints', leftSqlPublic, rightSqlPublic),
        detail('private', 'Private IP endpoints', leftSql.filter((instance) => instance.privateAddress).length, rightSql.filter((instance) => instance.privateAddress).length),
        detail('auto_resize', 'Storage auto-resize enabled', leftSql.filter((instance) => instance.storageAutoResizeEnabled).length, rightSql.filter((instance) => instance.storageAutoResizeEnabled).length)
      ],
      left.projectId, left.location
    ),
    makeRow(
      `gcp-compare:billing:${left.projectId}:${right.projectId}`, 'cost', 'Billing', 'Billing account posture', `${left.projectId} vs ${right.projectId}`,
      left.errors.billing || right.errors.billing || !left.billing?.billingEnabled || !right.billing?.billingEnabled ? 'high' : left.billing?.visibility !== 'full' || right.billing?.visibility !== 'full' ? 'medium' : 'low',
      'gcp-billing', 'Billing Overview', ['cost', 'drift-compliance'],
      left.errors.billing || right.errors.billing
        ? `Billing overview load was partial. Left: ${left.errors.billing ?? 'ok'}. Right: ${right.errors.billing ?? 'ok'}.`
        : 'Shows whether billing is attached, how much linked-project visibility exists, and how much ownership labeling is available.',
      left.billing?.billingEnabled ? 'Attached' : 'Detached', `${left.billing?.linkedProjects.length ?? 0} linked | ${Math.round(left.billing?.linkedProjectLabelCoveragePercent ?? 0)}% labeled`,
      right.billing?.billingEnabled ? 'Attached' : 'Detached', `${right.billing?.linkedProjects.length ?? 0} linked | ${Math.round(right.billing?.linkedProjectLabelCoveragePercent ?? 0)}% labeled`,
      [
        detail('attached', 'Billing enabled', left.billing?.billingEnabled ?? false, right.billing?.billingEnabled ?? false),
        detail('visibility', 'Visibility', left.billing?.visibility ?? 'Unavailable', right.billing?.visibility ?? 'Unavailable'),
        detail('linked_projects', 'Linked projects', left.billing?.linkedProjects.length ?? 0, right.billing?.linkedProjects.length ?? 0),
        detail('label_coverage', 'Label coverage %', Math.round(left.billing?.linkedProjectLabelCoveragePercent ?? 0), Math.round(right.billing?.linkedProjectLabelCoveragePercent ?? 0)),
        detail('billing_account', 'Billing account', left.billing?.billingAccountDisplayName || left.billing?.billingAccountName || '-', right.billing?.billingAccountDisplayName || right.billing?.billingAccountName || '-')
      ],
      left.projectId, left.location
    )
  ]
}

function renderCard(row: Row, selectedRowId: string, leftLabel: string, rightLabel: string, onSelect: (id: string) => void) {
  return (
    <button
      key={row.id}
      type="button"
      className={`compare-inventory-card ${selectedRowId === row.id ? 'active' : ''}`}
      onClick={() => onSelect(row.id)}
    >
      <div className="compare-inventory-card-head">
        <div className="compare-inventory-card-copy">
          <strong>{row.title}</strong>
          <span>{row.subtitle}</span>
        </div>
        <span className={`status-chip ${row.status}`}>{row.status}</span>
      </div>
      <div className="compare-inventory-card-meta">
        <span>{row.sectionLabel}</span>
        <span>{row.resourceType}</span>
        <span>Risk {row.risk}</span>
      </div>
      <div className="compare-compare-values">
        <div>
          <small>{leftLabel}</small>
          <strong>{row.left.value}</strong>
          <span>{row.left.secondary || '-'}</span>
        </div>
        <div>
          <small>{rightLabel}</small>
          <strong>{row.right.value}</strong>
          <span>{row.right.secondary || '-'}</span>
        </div>
      </div>
      <p>{row.rationale}</p>
    </button>
  )
}

export function GcpCompareWorkspace({
  projectId,
  location,
  catalogProjects,
  locationOptions,
  refreshNonce = 0,
  onNavigate
}: {
  projectId: string
  location: string
  catalogProjects: GcpCliProject[]
  locationOptions: string[]
  refreshNonce?: number
  onNavigate: (serviceId: ServiceId) => void
}) {
  const projectIds = useMemo(() => {
    const ids = catalogProjects.map((entry) => entry.projectId).filter(Boolean)
    return ids.length > 0 ? ids : [projectId]
  }, [catalogProjects, projectId])
  const allLocations = useMemo(() => [...new Set([location, ...locationOptions].filter(Boolean))], [location, locationOptions])

  const [leftProjectId, setLeftProjectId] = useState(projectId)
  const [rightProjectId, setRightProjectId] = useState(() => projectIds.find((candidate) => candidate !== projectId) ?? projectId)
  const [leftLocation, setLeftLocation] = useState(location)
  const [rightLocation, setRightLocation] = useState(location)
  const [focusMode, setFocusMode] = useState<ComparisonFocusMode>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | ComparisonDiffStatus>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [coverage, setCoverage] = useState<Array<{ label: string; status: 'full' | 'partial' }>>([])
  const [selectedRowId, setSelectedRowId] = useState('')
  const [generatedAt, setGeneratedAt] = useState('')

  useEffect(() => {
    setLeftProjectId(projectId)
    setLeftLocation(location)
    setRightProjectId((current) => current || (projectIds.find((candidate) => candidate !== projectId) ?? projectId))
    setRightLocation((current) => current || location)
  }, [location, projectId, projectIds])

  async function runDiff(): Promise<void> {
    setLoading(true)
    setError('')
    try {
      const [left, right] = await Promise.all([
        loadSnapshot(leftProjectId, leftLocation, projectIds),
        loadSnapshot(rightProjectId, rightLocation, projectIds)
      ])
      const nextRows = buildRows(left, right)
      setRows(nextRows)
      setCoverage(nextRows.map((row) => ({
        label: row.sectionLabel,
        status: row.rationale.includes('partial') ? 'partial' : 'full'
      })))
      setSelectedRowId(nextRows.find((row) => row.status !== 'same')?.id ?? nextRows[0]?.id ?? '')
      setGeneratedAt(new Date().toISOString())
    } catch (loadError) {
      setRows([])
      setCoverage([])
      setSelectedRowId('')
      setError(text(loadError))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void runDiff()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!refreshNonce) return
    void runDiff()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshNonce])

  const leftLabel = `${leftProjectId} | ${leftLocation}`
  const rightLabel = `${rightProjectId} | ${rightLocation}`
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (focusMode !== 'all' && !row.focusModes.includes(focusMode)) return false
      if (statusFilter !== 'all' && row.status !== statusFilter) return false
      if (!query) return true
      return [row.title, row.subtitle, row.sectionLabel, row.rationale, row.left.value, row.right.value].join(' ').toLowerCase().includes(query)
    })
  }, [focusMode, rows, search, statusFilter])
  const selectedRow = filteredRows.find((row) => row.id === selectedRowId) ?? rows.find((row) => row.id === selectedRowId) ?? filteredRows[0] ?? rows[0] ?? null
  const differentCount = filteredRows.filter((row) => row.status === 'different').length
  const sameCount = filteredRows.filter((row) => row.status === 'same').length
  const highRiskCount = filteredRows.filter((row) => row.risk === 'high').length

  return (
    <div className="compare-console gcp-compare-console">
      {error && <SvcState variant="error" error={error} />}

      <section className="compare-shell-hero">
        <div className="compare-shell-hero-copy">
          <div className="eyebrow">Compare</div>
          <h2>Google Cloud shared compare workspace</h2>
          <p>Compares two GCP project and location contexts from the shared workspace entry point instead of the previous preview placeholder.</p>
          <div className="compare-shell-meta-strip">
            <div className="compare-shell-meta-pill"><span>Left context</span><strong>{optionLabel(leftProjectId, catalogProjects)} | {leftLocation}</strong></div>
            <div className="compare-shell-meta-pill"><span>Right context</span><strong>{optionLabel(rightProjectId, catalogProjects)} | {rightLocation}</strong></div>
            <div className="compare-shell-meta-pill"><span>Catalog projects</span><strong>{projectIds.length}</strong></div>
            <div className="compare-shell-meta-pill"><span>Generated</span><strong>{generatedAt ? new Date(generatedAt).toLocaleString() : 'Pending'}</strong></div>
          </div>
        </div>
        <div className="compare-shell-hero-stats">
          <div className="compare-shell-stat-card compare-shell-stat-card-accent"><span>Tracked services</span><strong>{rows.length}</strong><small>Projects, IAM, compute, GKE, storage, SQL, and billing</small></div>
          <div className="compare-shell-stat-card"><span>Different</span><strong>{differentCount}</strong><small>Rows with visible delta</small></div>
          <div className="compare-shell-stat-card"><span>Same</span><strong>{sameCount}</strong><small>Rows currently aligned</small></div>
          <div className="compare-shell-stat-card"><span>High risk</span><strong>{highRiskCount}</strong><small>Rows needing attention</small></div>
          <div className="compare-shell-stat-card"><span>Coverage</span><strong>{coverage.filter((item) => item.status === 'full').length} / {coverage.length}</strong><small>Fully loaded service rows</small></div>
          <div className="compare-shell-stat-card"><span>Selected row</span><strong>{selectedRow?.title ?? 'None'}</strong><small>{selectedRow?.resourceType ?? 'Choose a row to inspect details'}</small></div>
        </div>
      </section>

      <section className="compare-shell-toolbar">
        <div className="compare-toolbar-main">
          <div className="compare-toolbar-copy">
            <span className="compare-pane-kicker">Diff controls</span>
            <h3>Projects and locations</h3>
          </div>
          <div className="compare-context-grid">
            <label className="field"><span>Left project</span><select value={leftProjectId} onChange={(event) => setLeftProjectId(event.target.value)}>{projectIds.map((candidate) => <option key={candidate} value={candidate}>{optionLabel(candidate, catalogProjects)}</option>)}</select></label>
            <label className="field"><span>Left location</span><select value={leftLocation} onChange={(event) => setLeftLocation(event.target.value)}>{allLocations.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label>
            <label className="field"><span>Right project</span><select value={rightProjectId} onChange={(event) => setRightProjectId(event.target.value)}>{projectIds.map((candidate) => <option key={candidate} value={candidate}>{optionLabel(candidate, catalogProjects)}</option>)}</select></label>
            <label className="field"><span>Right location</span><select value={rightLocation} onChange={(event) => setRightLocation(event.target.value)}>{allLocations.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label>
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
            <div className="compare-pane-head">
              <div>
                <span className="compare-pane-kicker">Delta inventory</span>
                <h3>Service-level compare rows</h3>
              </div>
              <span className="compare-pane-summary">{filteredRows.length} rows</span>
            </div>
            <div className="compare-inventory-list">
              {filteredRows.map((row) => renderCard(row, selectedRowId, leftLabel, rightLabel, setSelectedRowId))}
            </div>
            {filteredRows.length === 0 && <div className="compare-empty">No rows match the current filters.</div>}
          </section>

          <section className="compare-detail-pane">
            <section className="compare-filter-panel">
              <div className="compare-pane-head">
                <div>
                  <span className="compare-pane-kicker">Detail controls</span>
                  <h3>Filters and coverage</h3>
                </div>
              </div>
              <div className="overview-chip-row compare-chip-row compare-chip-row-full">
                {FOCUS_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={`overview-service-chip ${focusMode === option.value ? 'active' : ''}`}
                    onClick={() => setFocusMode(option.value)}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
              <div className="compare-filter-grid">
                <label className="field">
                  <span>Status</span>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as 'all' | ComparisonDiffStatus)}>
                    <option value="all">All</option>
                    <option value="different">Different</option>
                    <option value="same">Same</option>
                  </select>
                </label>
                <label className="field">
                  <span>Search</span>
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter compare rows" />
                </label>
              </div>
              <div className="compare-shell-meta-strip">
                {coverage.map((item) => (
                  <div key={item.label} className="compare-shell-meta-pill">
                    <span>{item.label}</span>
                    <strong>{item.status}</strong>
                  </div>
                ))}
              </div>
            </section>

            {selectedRow ? (
              <>
                <section className="compare-detail-hero">
                  <div className="compare-detail-hero-copy">
                    <div className="eyebrow">Selected diff</div>
                    <h3>{selectedRow.title}</h3>
                    <p>{selectedRow.rationale}</p>
                    <div className="compare-shell-meta-strip">
                      <div className="compare-shell-meta-pill"><span>Section</span><strong>{selectedRow.sectionLabel}</strong></div>
                      <div className="compare-shell-meta-pill"><span>Status</span><strong>{selectedRow.status}</strong></div>
                      <div className="compare-shell-meta-pill"><span>Risk</span><strong>{selectedRow.risk}</strong></div>
                      <div className="compare-shell-meta-pill"><span>Service</span><strong>{selectedRow.serviceId}</strong></div>
                    </div>
                  </div>
                  <div className="compare-detail-hero-stats">
                    <div className="compare-shell-stat-card"><span>{leftLabel}</span><strong>{selectedRow.left.value}</strong><small>{selectedRow.left.secondary || '-'}</small></div>
                    <div className="compare-shell-stat-card"><span>{rightLabel}</span><strong>{selectedRow.right.value}</strong><small>{selectedRow.right.secondary || '-'}</small></div>
                    <div className="compare-shell-stat-card"><span>Resource type</span><strong className="compare-shell-stat-card-value compare-shell-stat-card-value-wrap">{selectedRow.resourceType}</strong><small>{selectedRow.subtitle}</small></div>
                    <div className="compare-shell-stat-card"><span>Navigation</span><strong className="compare-shell-stat-card-value">{selectedRow.navigation?.serviceId ?? 'Not linked'}</strong><small>Open the related GCP service page</small></div>
                  </div>
                </section>

                <section className="compare-detail-section">
                  <div className="compare-pane-head">
                    <div>
                      <span className="compare-pane-kicker">Field comparison</span>
                      <h3>Left versus right values</h3>
                    </div>
                    {selectedRow.navigation && (
                      <button type="button" className="tf-toolbar-btn" onClick={() => onNavigate(selectedRow.navigation!.serviceId)}>
                        Open {selectedRow.navigation.serviceId}
                      </button>
                    )}
                  </div>
                  <div className="table-grid">
                    <div className="table-row table-head compare-detail-grid">
                      <div>Field</div>
                      <div>{leftLabel}</div>
                      <div>{rightLabel}</div>
                    </div>
                    {selectedRow.detailFields.map((field) => (
                      <div key={field.key} className="table-row compare-detail-grid">
                        <div>{field.label}</div>
                        <div>{field.leftValue || '-'}</div>
                        <div>{field.rightValue || '-'}</div>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : (
              <section className="compare-detail-section">
                <SvcState variant="no-selection" message="Select a compare row to inspect field-level differences." />
              </section>
            )}
          </section>
        </div>
      ) : (
        <section className="compare-detail-section">
          <SvcState variant="loading" message={loading ? 'Comparing the selected Google Cloud contexts...' : 'Run the compare to load project, IAM, compute, storage, SQL, and billing deltas.'} />
        </section>
      )}
    </div>
  )
}
