import { useEffect, useMemo, useState } from 'react'

import type {
  GcpCliProject,
  GcpComputeInstanceSummary,
  GcpGkeClusterSummary,
  GcpIamOverview,
  GcpServiceAccountSummary,
  GcpSqlInstanceSummary,
  GcpStorageBucketSummary,
  GcpStorageObjectSummary,
  ServiceId
} from '@shared/types'
import {
  getGcpBillingOverview,
  getGcpIamOverview,
  getGcpProjectOverview,
  getGcpStorageObjectContent,
  listGcpComputeInstances,
  listGcpGkeClusters,
  listGcpSqlInstances,
  listGcpStorageBuckets,
  listGcpStorageObjects
} from './api'
import './direct-resource.css'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import { SvcState } from './SvcState'

type GcpDirectTarget =
  | 'project'
  | 'service-account'
  | 'compute-instance'
  | 'gke-cluster'
  | 'storage-bucket'
  | 'storage-object'
  | 'sql-instance'
  | 'billing'

type DirectField = { key: keyof DirectFormState; label: string; placeholder: string; required?: boolean }
type TargetDefinition = {
  key: GcpDirectTarget
  label: string
  description: string
  serviceId: ServiceId
  fields: DirectField[]
  isReady?: (form: DirectFormState, context: { projectId: string }) => boolean
}
type ResultSection = { title: string; data: unknown }
type DirectFormState = {
  lookupProjectId: string
  serviceAccountEmail: string
  instanceName: string
  clusterName: string
  bucketName: string
  prefix: string
  objectKey: string
  sqlInstanceName: string
  billingProjectId: string
}

const TARGETS: TargetDefinition[] = [
  {
    key: 'project',
    label: 'Project',
    description: 'Open the selected project context directly and inspect metadata, APIs, and capability hints.',
    serviceId: 'gcp-projects',
    fields: [{ key: 'lookupProjectId', label: 'Project ID', placeholder: 'prod-core', required: true }]
  },
  {
    key: 'service-account',
    label: 'Service Account',
    description: 'Inspect one service account and its relevant IAM posture from the current project policy.',
    serviceId: 'gcp-iam',
    fields: [{ key: 'serviceAccountEmail', label: 'Service Account Email', placeholder: 'cloud-ops@project-id.iam.gserviceaccount.com', required: true }]
  },
  {
    key: 'compute-instance',
    label: 'Compute Instance',
    description: 'Lookup a known Compute Engine instance by exact name inside the selected project and location.',
    serviceId: 'gcp-compute-engine',
    fields: [{ key: 'instanceName', label: 'Instance Name', placeholder: 'web-01', required: true }]
  },
  {
    key: 'gke-cluster',
    label: 'GKE Cluster',
    description: 'Open a GKE cluster directly by exact cluster name.',
    serviceId: 'gcp-gke',
    fields: [{ key: 'clusterName', label: 'Cluster Name', placeholder: 'prod-cluster', required: true }]
  },
  {
    key: 'storage-bucket',
    label: 'Storage Bucket',
    description: 'Inspect a Cloud Storage bucket and list objects at a known prefix.',
    serviceId: 'gcp-cloud-storage',
    fields: [
      { key: 'bucketName', label: 'Bucket Name', placeholder: 'prod-artifacts', required: true },
      { key: 'prefix', label: 'Prefix', placeholder: 'leave empty for root or use path/' }
    ]
  },
  {
    key: 'storage-object',
    label: 'Storage Object',
    description: 'Describe a specific object and preview text content when supported.',
    serviceId: 'gcp-cloud-storage',
    fields: [
      { key: 'bucketName', label: 'Bucket Name', placeholder: 'prod-artifacts', required: true },
      { key: 'objectKey', label: 'Object Key', placeholder: 'configs/app.yaml', required: true }
    ]
  },
  {
    key: 'sql-instance',
    label: 'Cloud SQL',
    description: 'Open a Cloud SQL instance directly by exact instance name.',
    serviceId: 'gcp-cloud-sql',
    fields: [{ key: 'sqlInstanceName', label: 'Instance Name', placeholder: 'orders-primary', required: true }]
  },
  {
    key: 'billing',
    label: 'Billing',
    description: 'Inspect billing linkage and ownership hints for a known project id.',
    serviceId: 'gcp-billing',
    fields: [{ key: 'billingProjectId', label: 'Project ID', placeholder: 'prod-core', required: true }]
  }
]

const INITIAL_FORM: DirectFormState = {
  lookupProjectId: '',
  serviceAccountEmail: '',
  instanceName: '',
  clusterName: '',
  bucketName: '',
  prefix: '',
  objectKey: '',
  sqlInstanceName: '',
  billingProjectId: ''
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2)
const summarizeSectionData = (data: unknown) => Array.isArray(data)
  ? `${data.length} item${data.length === 1 ? '' : 's'}`
  : data && typeof data === 'object'
    ? `${Object.keys(data as Record<string, unknown>).length} field${Object.keys(data as Record<string, unknown>).length === 1 ? '' : 's'}`
    : typeof data === 'string'
      ? (data.length > 80 ? `${data.length} chars` : data)
      : data == null
        ? 'Empty payload'
        : typeof data

function matchesServiceAccount(overview: GcpIamOverview, email: string) {
  const emailLower = email.toLowerCase()
  const account = overview.serviceAccounts.find((entry) => entry.email.toLowerCase() === emailLower) ?? null
  const principal = overview.principals.find((entry) => entry.principal.toLowerCase().includes(emailLower)) ?? null
  const bindings = overview.bindings.filter((entry) => entry.members.some((member) => member.toLowerCase().includes(emailLower)))
  return { account, principal, bindings }
}

function findComputeInstance(instances: GcpComputeInstanceSummary[], name: string) {
  const lower = name.toLowerCase()
  return instances.find((entry) => entry.name.toLowerCase() === lower || entry.internalIp === name || entry.externalIp === name) ?? null
}

function findCluster(clusters: GcpGkeClusterSummary[], name: string) {
  const lower = name.toLowerCase()
  return clusters.find((entry) => entry.name.toLowerCase() === lower) ?? null
}

function findBucket(buckets: GcpStorageBucketSummary[], name: string) {
  const lower = name.toLowerCase()
  return buckets.find((entry) => entry.name.toLowerCase() === lower) ?? null
}

function findSqlInstance(instances: GcpSqlInstanceSummary[], name: string) {
  const lower = name.toLowerCase()
  return instances.find((entry) => entry.name.toLowerCase() === lower) ?? null
}

function directCommand(target: GcpDirectTarget, form: DirectFormState, projectId: string, location: string): string {
  switch (target) {
    case 'project':
      return `gcloud projects describe ${form.lookupProjectId.trim() || projectId} --format=json`
    case 'service-account':
      return `gcloud iam service-accounts describe ${form.serviceAccountEmail.trim()} --project ${projectId} --format=json`
    case 'compute-instance':
      return `gcloud compute instances list --project ${projectId} --filter="name=${form.instanceName.trim()}" --format=json`
    case 'gke-cluster':
      return `gcloud container clusters describe ${form.clusterName.trim()} --project ${projectId} --location ${location} --format=json`
    case 'storage-bucket':
      return `gcloud storage buckets describe gs://${form.bucketName.trim()} --project ${projectId}`
    case 'storage-object':
      return `gcloud storage objects describe gs://${form.bucketName.trim()}/${form.objectKey.trim()} --format=json`
    case 'sql-instance':
      return `gcloud sql instances describe ${form.sqlInstanceName.trim()} --project ${projectId}`
    case 'billing':
      return `gcloud beta billing projects describe ${form.billingProjectId.trim() || projectId}`
  }
}

function isDefinitionReady(definition: TargetDefinition, form: DirectFormState, projectId: string): boolean {
  if (definition.isReady) {
    return definition.isReady(form, { projectId })
  }

  return !definition.fields.some((field) => field.required && !String(form[field.key] || '').trim())
}

export function GcpDirectAccessWorkspace({
  projectId,
  location,
  catalogProjects,
  refreshNonce = 0,
  canRunTerminalCommand,
  terminalReady,
  onNavigate,
  onRunTerminalCommand
}: {
  projectId: string
  location: string
  catalogProjects: GcpCliProject[]
  refreshNonce?: number
  canRunTerminalCommand: boolean
  terminalReady: boolean
  onNavigate: (serviceId: ServiceId, resourceId?: string) => void
  onRunTerminalCommand: (command: string) => void
}) {
  const [selectedTarget, setSelectedTarget] = useState<GcpDirectTarget>('project')
  const [form, setForm] = useState<DirectFormState>(INITIAL_FORM)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sections, setSections] = useState<ResultSection[]>([])
  const [selectedSectionIndex, setSelectedSectionIndex] = useState(0)
  const { freshness, beginRefresh, completeRefresh, failRefresh, replaceFetchedAt } = useFreshnessState({ staleAfterMs: 10 * 60 * 1000 })

  useEffect(() => {
    setForm((current) => ({
      ...current,
      lookupProjectId: current.lookupProjectId || projectId,
      billingProjectId: current.billingProjectId || projectId
    }))
  }, [projectId])

  useEffect(() => {
    if (refreshNonce > 0) {
      replaceFetchedAt(null)
    }
  }, [refreshNonce, replaceFetchedAt])

  const definition = useMemo(() => TARGETS.find((entry) => entry.key === selectedTarget) ?? TARGETS[0], [selectedTarget])
  const selectedSection = sections[selectedSectionIndex] ?? null
  const selectedProjectSummary = useMemo(
    () => catalogProjects.find((entry) => entry.projectId === projectId) ?? catalogProjects.find((entry) => entry.projectId === form.lookupProjectId.trim()) ?? null,
    [catalogProjects, form.lookupProjectId, projectId]
  )
  const openDisabled = !projectId || !location || !isDefinitionReady(definition, form, projectId)
  const terminalCommand = directCommand(selectedTarget, form, projectId, location)
  const terminalActionDisabled = !canRunTerminalCommand || !terminalReady || openDisabled

  function updateField(key: keyof DirectFormState, value: string): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function handleSelectTarget(target: GcpDirectTarget): void {
    setSelectedTarget(target)
    setError('')
    setSections([])
    setSelectedSectionIndex(0)
    replaceFetchedAt(null)
  }

  function handleReset(): void {
    setForm({
      ...INITIAL_FORM,
      lookupProjectId: projectId,
      billingProjectId: projectId
    })
    setError('')
    setSections([])
    setSelectedSectionIndex(0)
    replaceFetchedAt(null)
  }

  async function handleOpen(): Promise<void> {
    beginRefresh('manual')
    setLoading(true)
    setError('')
    setSections([])
    setSelectedSectionIndex(0)

    try {
      let nextSections: ResultSection[] = []

      switch (selectedTarget) {
        case 'project': {
          const lookupProjectId = form.lookupProjectId.trim() || projectId
          const [overview, projectCatalogSummary] = await Promise.all([
            getGcpProjectOverview(lookupProjectId),
            Promise.resolve(catalogProjects.find((entry) => entry.projectId === lookupProjectId) ?? null)
          ])

          nextSections = [
            { title: `Project ${lookupProjectId}`, data: overview },
            { title: 'Catalog summary', data: projectCatalogSummary },
            { title: 'Enabled APIs', data: overview.enabledApis },
            { title: 'Capability hints', data: overview.capabilityHints },
            { title: 'Notes', data: overview.notes }
          ]
          break
        }
        case 'service-account': {
          const email = form.serviceAccountEmail.trim()
          const overview = await getGcpIamOverview(projectId)
          const match = matchesServiceAccount(overview, email)
          if (!match.account) {
            throw new Error('Service account was not found in the current project IAM posture. Use an exact service account email from the selected project.')
          }

          nextSections = [
            { title: match.account.email, data: match.account },
            { title: 'Principal summary', data: match.principal },
            { title: 'Relevant bindings', data: match.bindings },
            { title: 'Capability hints', data: overview.capabilityHints },
            { title: 'Notes', data: overview.notes }
          ]
          break
        }
        case 'compute-instance': {
          const instances = await listGcpComputeInstances(projectId, location)
          const instance = findComputeInstance(instances, form.instanceName.trim())
          if (!instance) {
            throw new Error('Compute Engine instance was not found in the selected project and location. Use the exact instance name or a known IP from this slice.')
          }

          nextSections = [
            { title: instance.name, data: instance },
            { title: 'Networking posture', data: { internalIp: instance.internalIp, externalIp: instance.externalIp, zone: instance.zone, status: instance.status } },
            { title: 'Nearby inventory', data: instances }
          ]
          break
        }
        case 'gke-cluster': {
          const clusters = await listGcpGkeClusters(projectId, location)
          const cluster = findCluster(clusters, form.clusterName.trim())
          if (!cluster) {
            throw new Error('GKE cluster was not found in the selected project and location. Use the exact cluster name from this slice.')
          }

          nextSections = [
            { title: cluster.name, data: cluster },
            { title: 'Cluster inventory', data: clusters }
          ]
          break
        }
        case 'storage-bucket': {
          const buckets = await listGcpStorageBuckets(projectId, location)
          const bucket = findBucket(buckets, form.bucketName.trim())
          if (!bucket) {
            throw new Error('Bucket was not found in the selected project and location. Use an exact bucket name from the active Cloud Storage slice.')
          }

          const objects = await listGcpStorageObjects(projectId, bucket.name, form.prefix.trim())
          nextSections = [
            { title: bucket.name, data: bucket },
            { title: `Objects at ${form.prefix.trim() || '/'}`, data: objects },
            { title: 'Bucket inventory', data: buckets }
          ]
          break
        }
        case 'storage-object': {
          const bucketName = form.bucketName.trim()
          const objectKey = form.objectKey.trim()
          const objects = await listGcpStorageObjects(projectId, bucketName, objectKey)
          const object = objects.find((entry) => entry.key === objectKey) ?? null
          if (!object) {
            throw new Error('Object was not found in the selected bucket. Use the exact object key from the current Cloud Storage workflow.')
          }

          let preview: { contentType: string; preview: string } | null = null
          if (!object.isFolder) {
            try {
              const content = await getGcpStorageObjectContent(projectId, bucketName, object.key)
              preview = {
                contentType: content.contentType,
                preview: content.body.length > 2000 ? `${content.body.slice(0, 2000)}\n…` : content.body
              }
            } catch {
              preview = null
            }
          }

          nextSections = [
            { title: object.key, data: object },
            { title: 'Preview', data: preview ?? { message: 'Preview unavailable for this object type or size.' } },
            { title: `Objects near ${objectKey}`, data: objects }
          ]
          break
        }
        case 'sql-instance': {
          const instances = await listGcpSqlInstances(projectId, location)
          const instance = findSqlInstance(instances, form.sqlInstanceName.trim())
          if (!instance) {
            throw new Error('Cloud SQL instance was not found in the selected project and location. Use the exact instance name from the active SQL slice.')
          }

          nextSections = [
            { title: instance.name, data: instance },
            { title: 'SQL inventory', data: instances }
          ]
          break
        }
        case 'billing': {
          const lookupProjectId = form.billingProjectId.trim() || projectId
          const overview = await getGcpBillingOverview(lookupProjectId, catalogProjects.map((entry) => entry.projectId))
          nextSections = [
            { title: `Billing ${lookupProjectId}`, data: overview },
            { title: 'Linked projects', data: overview.linkedProjects },
            { title: 'Capability hints', data: overview.capabilityHints },
            { title: 'Ownership hints', data: overview.ownershipHints },
            { title: 'Notes', data: overview.notes }
          ]
          break
        }
      }

      setSections(nextSections)
      setSelectedSectionIndex(0)
      completeRefresh()
    } catch (err) {
      failRefresh()
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="svc-console direct-console">
      {!canRunTerminalCommand ? (
        <div className="error-banner">
          Read mode active. Terminal describe commands are disabled on this screen.
        </div>
      ) : !terminalReady ? (
        <div className="error-banner">
          Terminal context is not ready yet. Select a Google Cloud project and location first so `gcloud` commands inherit the correct shell scope.
        </div>
      ) : null}

      <section className="direct-shell-hero">
        <div className="direct-shell-copy">
          <div className="eyebrow">Direct resource access</div>
          <h2>Google Cloud direct lookup workspace</h2>
          <p>Open a known Google Cloud resource directly from the shared shell context, inspect the raw payload, then hand off into the deeper service console without losing project or location scope.</p>
          <div className="direct-shell-meta-strip">
            <div className="direct-shell-meta-pill"><span>Project</span><strong>{projectId || 'Not selected'}</strong></div>
            <div className="direct-shell-meta-pill"><span>Location</span><strong>{location || 'Not selected'}</strong></div>
            <div className="direct-shell-meta-pill"><span>Target</span><strong>{definition.label}</strong></div>
            <div className="direct-shell-meta-pill"><span>Service</span><strong>{definition.serviceId}</strong></div>
          </div>
        </div>
        <div className="direct-shell-stats">
          <div className="direct-shell-stat-card direct-shell-stat-card-accent"><span>Lookup targets</span><strong>{TARGETS.length}</strong><small>Project, IAM, compute, storage, SQL, and billing direct paths.</small></div>
          <div className="direct-shell-stat-card"><span>Catalog projects</span><strong>{catalogProjects.length}</strong><small>{selectedProjectSummary?.name || 'Using the active shared project context.'}</small></div>
          <div className="direct-shell-stat-card"><span>Mode</span><strong>{canRunTerminalCommand ? 'Operator' : 'Read'}</strong><small>{canRunTerminalCommand ? 'Terminal handoff ready when context is complete.' : 'Describe commands are intentionally disabled.'}</small></div>
          <div className="direct-shell-stat-card"><span>Last lookup</span><strong>{freshness.fetchedAt ? new Date(freshness.fetchedAt).toLocaleTimeString() : 'Pending'}</strong><small>Refresh happens per direct lookup, not background polling.</small></div>
        </div>
      </section>

      <div className="direct-shell-toolbar">
        <div className="direct-toolbar">
          <button type="button" className="direct-toolbar-btn accent" onClick={() => void handleOpen()} disabled={loading || openDisabled}>{loading ? 'Opening...' : 'Open resource'}</button>
          <button type="button" className="direct-toolbar-btn" onClick={() => onNavigate(definition.serviceId, selectedTarget === 'project' ? (form.lookupProjectId.trim() || projectId) : projectId)}>Open service</button>
          <button type="button" className="direct-toolbar-btn" onClick={handleReset}>Reset</button>
          <button type="button" className="direct-toolbar-btn" disabled={terminalActionDisabled} onClick={() => onRunTerminalCommand(terminalCommand)} title={terminalActionDisabled ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : !terminalReady ? 'Select a project and location to prepare the terminal context' : 'Fill the required lookup fields first') : terminalCommand}>Inspect in terminal</button>
        </div>
        <div className="direct-shell-status"><FreshnessIndicator freshness={freshness} label="Direct lookup" staleLabel="Open resource" /></div>
      </div>

      {!projectId || !location ? (
        <SvcState variant="empty" message="Select a Google Cloud project and location to enable direct resource lookup for this provider." />
      ) : (
        <div className="direct-main-layout">
          <div className="direct-service-pane">
            <div className="direct-pane-head"><div><span className="direct-pane-kicker">Target inventory</span><h3>Lookup targets</h3></div><span className="direct-pane-summary">{TARGETS.length} total</span></div>
            <div className="direct-service-list">
              {TARGETS.map((entry) => {
                const isActive = entry.key === selectedTarget
                return (
                  <button key={entry.key} type="button" className={`direct-service-row ${isActive ? 'active' : ''}`} onClick={() => handleSelectTarget(entry.key)}>
                    <div className="direct-service-row-top">
                      <strong>{entry.label}</strong>
                      <span>{entry.serviceId}</span>
                    </div>
                    <div className="direct-service-row-summary">{entry.description}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="direct-detail-pane">
            <section className="direct-detail-hero">
              <div className="direct-detail-copy">
                <div className="eyebrow">Lookup configuration</div>
                <h3>{definition.label}</h3>
                <p>{definition.description}</p>
                <div className="direct-detail-meta-strip">
                  <div className="direct-detail-meta-pill"><span>Project scope</span><strong>{projectId}</strong></div>
                  <div className="direct-detail-meta-pill"><span>Location scope</span><strong>{location}</strong></div>
                  <div className="direct-detail-meta-pill"><span>Lookup state</span><strong>{openDisabled ? 'Needs input' : 'Ready'}</strong></div>
                </div>
              </div>
              <div className="direct-detail-stats">
                <div className="direct-detail-stat-card success"><span>Required fields</span><strong>{definition.fields.filter((field) => field.required).length}</strong><small>Known identifiers needed before the lookup can run.</small></div>
                <div className="direct-detail-stat-card warning"><span>Results</span><strong>{sections.length}</strong><small>Payload sections captured from the last direct lookup.</small></div>
              </div>
            </section>

            <section className="direct-section">
              <div className="direct-section-head"><div><span className="direct-pane-kicker">Parameters</span><h3>Known identifiers</h3></div></div>
              <div className="direct-form-grid">
                {definition.fields.map((field) => (
                  <label key={field.key} className={`direct-field ${definition.fields.length === 1 ? 'direct-field-wide' : ''}`}>
                    <span>{field.label}{field.required ? <em>Required</em> : <em>Optional</em>}</span>
                    <input value={form[field.key] ?? ''} onChange={(event) => updateField(field.key, event.target.value)} placeholder={field.placeholder} />
                  </label>
                ))}
              </div>
              {error ? <SvcState variant="error" error={error} /> : null}
            </section>

            <section className="direct-section">
              <div className="direct-section-head"><div><span className="direct-pane-kicker">Response</span><h3>Lookup output</h3></div></div>
              {!sections.length ? (
                loading
                  ? <SvcState variant="loading" resourceName="resource data" message="Opening resource and gathering payloads..." />
                  : <SvcState variant="empty" message="Fill the lookup fields and open a Google Cloud resource directly." />
              ) : (
                <div className="direct-result-shell">
                  <div className="direct-result-list">
                    {sections.map((section, index) => (
                      <button key={`${section.title}:${index}`} type="button" className={`direct-result-row ${index === selectedSectionIndex ? 'active' : ''}`} onClick={() => setSelectedSectionIndex(index)}>
                        <strong>{section.title}</strong>
                        <span>{summarizeSectionData(section.data)}</span>
                      </button>
                    ))}
                  </div>
                  <div className="direct-result-viewer">
                    {selectedSection ? (
                      <>
                        <div className="direct-result-viewer-head">
                          <div><span className="direct-pane-kicker">Selected payload</span><h3>{selectedSection.title}</h3></div>
                          <span className="direct-result-summary">{summarizeSectionData(selectedSection.data)}</span>
                        </div>
                        <pre className="svc-code direct-result-code">{pretty(selectedSection.data)}</pre>
                      </>
                    ) : (
                      <SvcState variant="no-selection" resourceName="result section" />
                    )}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
