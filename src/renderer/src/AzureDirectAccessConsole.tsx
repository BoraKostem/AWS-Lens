import { useState } from 'react'

import type { ServiceId } from '@shared/types'
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
import './direct-resource.css'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import { SvcState } from './SvcState'

type AzureDirectServiceKey = 'virtual-machines' | 'aks' | 'storage-accounts' | 'storage-containers' | 'storage-blobs' | 'rbac' | 'sql-estate' | 'activity-log' | 'cost' | 'subscriptions'
type AzureDirectField = { key: string; label: string; placeholder: string; required?: boolean }
type AzureDirectServiceDef = { key: AzureDirectServiceKey; label: string; description: string; fields: AzureDirectField[] }
type AzureResultSection = { title: string; data: unknown }

const SERVICE_DEFINITIONS: AzureDirectServiceDef[] = [
  { key: 'virtual-machines', label: 'Virtual Machines', description: 'List VMs in the active subscription and location.', fields: [] },
  { key: 'aks', label: 'AKS Clusters', description: 'List managed Kubernetes clusters.', fields: [] },
  { key: 'storage-accounts', label: 'Storage Accounts', description: 'List storage accounts visible in the current scope.', fields: [] },
  { key: 'storage-containers', label: 'Storage Containers', description: 'List containers inside a known storage account.', fields: [{ key: 'resourceGroup', label: 'Resource Group', placeholder: 'my-rg', required: true }, { key: 'accountName', label: 'Storage Account Name', placeholder: 'mystorageaccount', required: true }, { key: 'blobEndpoint', label: 'Blob Endpoint', placeholder: 'https://mystorageaccount.blob.core.windows.net' }] },
  { key: 'storage-blobs', label: 'Storage Blobs', description: 'List blobs inside a known container.', fields: [{ key: 'resourceGroup', label: 'Resource Group', placeholder: 'my-rg', required: true }, { key: 'accountName', label: 'Storage Account Name', placeholder: 'mystorageaccount', required: true }, { key: 'containerName', label: 'Container Name', placeholder: 'my-container', required: true }, { key: 'prefix', label: 'Prefix', placeholder: 'leave empty for root' }, { key: 'blobEndpoint', label: 'Blob Endpoint', placeholder: 'https://mystorageaccount.blob.core.windows.net' }] },
  { key: 'rbac', label: 'RBAC Overview', description: 'Review role assignments, principals, and risky permissions.', fields: [] },
  { key: 'sql-estate', label: 'SQL Estate', description: 'Describe SQL servers and databases.', fields: [] },
  { key: 'activity-log', label: 'Activity Log', description: 'Query recent Azure Monitor activity events.', fields: [{ key: 'query', label: 'Query', placeholder: 'e.g. Microsoft.Compute', required: true }, { key: 'windowHours', label: 'Window (hours)', placeholder: '24' }] },
  { key: 'cost', label: 'Cost Overview', description: 'Retrieve current billing period cost breakdown.', fields: [] },
  { key: 'subscriptions', label: 'Subscriptions', description: 'List all subscriptions visible to the current identity.', fields: [] }
]

const INITIAL_FORM: Record<string, string> = { resourceGroup: '', accountName: '', containerName: '', prefix: '', blobEndpoint: '', query: '', windowHours: '24' }

const READ_ONLY_HINTS: Partial<Record<AzureDirectServiceKey, string[]>> = {
  'virtual-machines': ['Microsoft.Compute/virtualMachines/read'],
  aks: ['Microsoft.ContainerService/managedClusters/read'],
  'storage-accounts': ['Microsoft.Storage/storageAccounts/read'],
  'storage-containers': ['Microsoft.Storage/storageAccounts/blobServices/containers/read'],
  'storage-blobs': ['Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read'],
  rbac: ['Microsoft.Authorization/roleAssignments/read'],
  'sql-estate': ['Microsoft.Sql/servers/read', 'Microsoft.Sql/servers/databases/read'],
  'activity-log': ['Microsoft.Insights/eventtypes/values/read'],
  cost: ['Microsoft.CostManagement/query/read']
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2)
const summarizeSectionData = (data: unknown) => Array.isArray(data) ? `${data.length} item${data.length === 1 ? '' : 's'}` : data && typeof data === 'object' ? `${Object.keys(data as Record<string, unknown>).length} field${Object.keys(data as Record<string, unknown>).length === 1 ? '' : 's'}` : data == null ? 'Empty payload' : typeof data
const fieldValueCount = (def: AzureDirectServiceDef, form: Record<string, string>) => def.fields.filter((f) => form[f.key]?.trim()).length
const isDefinitionReady = (def: AzureDirectServiceDef, form: Record<string, string>) => !def.fields.some((f) => f.required && !form[f.key]?.trim())
const isAccessDeniedError = (msg: string) => { const n = msg.toLowerCase(); return n.includes('authorizationfailed') || n.includes('authorization failed') || n.includes('not authorized') || n.includes('forbidden') || n.includes('does not have authorization') }
const azurePortalUrl = () => 'https://portal.azure.com/#home'

export function AzureDirectAccessWorkspace({
  subscriptionId,
  subscriptionLabel,
  location,
  onNavigate,
  onOpenCompare,
  onOpenCompliance
}: {
  subscriptionId: string
  subscriptionLabel: string
  location: string
  onNavigate: (serviceId: ServiceId) => void
  onOpenCompare: () => void
  onOpenCompliance: () => void
}) {
  const [selectedService, setSelectedService] = useState<AzureDirectServiceKey>('virtual-machines')
  const [form, setForm] = useState<Record<string, string>>({ ...INITIAL_FORM })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sections, setSections] = useState<AzureResultSection[]>([])
  const [selectedSectionIndex, setSelectedSectionIndex] = useState(0)
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState()

  const definition = SERVICE_DEFINITIONS.find((d) => d.key === selectedService)!
  const openDisabled = !subscriptionId || !isDefinitionReady(definition, form)
  const populatedFieldCount = fieldValueCount(definition, form)
  const selectedSection = sections[selectedSectionIndex] ?? null
  const accessDenied = error ? isAccessDeniedError(error) : false
  const permissionHints = READ_ONLY_HINTS[selectedService] ?? []

  function updateField(key: string, value: string) { setForm((prev) => ({ ...prev, [key]: value })) }
  function handleSelectService(key: AzureDirectServiceKey) { setSelectedService(key) }
  function handleResetInputs() { setForm({ ...INITIAL_FORM }); setError('') }
  function handleClearResults() { setSections([]); setSelectedSectionIndex(0); setError('') }

  async function handleOpen(): Promise<void> {
    if (!subscriptionId) return
    setLoading(true)
    setError('')
    beginRefresh('manual')
    try {
      let nextSections: AzureResultSection[] = []
      switch (selectedService) {
        case 'virtual-machines':
          nextSections = [{ title: 'Virtual Machines', data: await listAzureVirtualMachines(subscriptionId, location) }]
          break
        case 'aks':
          nextSections = [{ title: 'AKS Clusters', data: await listAzureAksClusters(subscriptionId, location) }]
          break
        case 'storage-accounts':
          nextSections = [{ title: 'Storage Accounts', data: await listAzureStorageAccounts(subscriptionId, location) }]
          break
        case 'storage-containers':
          nextSections = [{ title: `Containers in ${form.accountName.trim()}`, data: await listAzureStorageContainers(subscriptionId, form.resourceGroup.trim(), form.accountName.trim(), form.blobEndpoint.trim() || '') }]
          break
        case 'storage-blobs':
          nextSections = [{ title: `Blobs in ${form.containerName.trim()}`, data: await listAzureStorageBlobs(subscriptionId, form.resourceGroup.trim(), form.accountName.trim(), form.containerName.trim(), form.prefix.trim(), form.blobEndpoint.trim() || '') }]
          break
        case 'rbac':
          nextSections = [{ title: 'RBAC Overview', data: await getAzureRbacOverview(subscriptionId) }]
          break
        case 'sql-estate':
          nextSections = [{ title: 'SQL Estate', data: await getAzureSqlEstate(subscriptionId, location) }]
          break
        case 'activity-log': {
          const hours = parseInt(form.windowHours.trim(), 10) || 24
          nextSections = [{ title: `Activity: ${form.query.trim()}`, data: await listAzureMonitorActivity(subscriptionId, location, form.query.trim(), hours) }]
          break
        }
        case 'cost':
          nextSections = [{ title: 'Cost Overview', data: await getAzureCostOverview(subscriptionId) }]
          break
        case 'subscriptions':
          nextSections = [{ title: 'Subscriptions', data: await listAzureSubscriptions() }]
          break
      }
      setSections(nextSections)
      setSelectedSectionIndex(0)
      completeRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="svc-console direct-console direct-console-azure">
      <section className="direct-shell-hero">
        <div className="direct-shell-copy">
          <div className="eyebrow">Direct resource access</div>
          <h2>{definition.label}</h2>
          <p>Query Azure resources directly from the active subscription when you already know the target or need a quick posture check.</p>
          <div className="direct-shell-meta-strip">
            <div className="direct-shell-meta-pill"><span>Subscription</span><strong>{subscriptionLabel || subscriptionId || 'Not selected'}</strong></div>
            <div className="direct-shell-meta-pill"><span>Location</span><strong>{location || 'Not set'}</strong></div>
            <div className="direct-shell-meta-pill"><span>Service</span><strong>{definition.label}</strong></div>
            <div className="direct-shell-meta-pill"><span>Payloads</span><strong>{sections.length || 'None yet'}</strong></div>
          </div>
        </div>
        <div className="direct-shell-stats">
          <div className="direct-shell-stat-card direct-shell-stat-card-accent"><span>Services</span><strong>{SERVICE_DEFINITIONS.length}</strong><small>Direct lookups available in this console</small></div>
          <div className="direct-shell-stat-card"><span>Inputs ready</span><strong>{definition.fields.length === 0 ? 'Auto' : `${populatedFieldCount}/${definition.fields.length}`}</strong><small>{definition.fields.length === 0 ? 'No parameters needed for this service' : openDisabled ? 'Complete the required identifiers' : 'Current request is ready to open'}</small></div>
          <div className="direct-shell-stat-card"><span>Result sections</span><strong>{sections.length}</strong><small>{sections.length ? 'Structured payloads returned from Azure' : 'No payload loaded yet'}</small></div>
          <div className="direct-shell-stat-card"><span>Active view</span><strong>{selectedSection?.title || 'Standby'}</strong><small>{selectedSection ? summarizeSectionData(selectedSection.data) : 'Open a resource to inspect details'}</small></div>
        </div>
      </section>

      <div className="direct-shell-toolbar">
        <div className="direct-toolbar">
          <button className="direct-toolbar-btn accent" type="button" onClick={() => void handleOpen()} disabled={loading || openDisabled}>{loading ? 'Opening...' : 'Open Resource'}</button>
          <button className="direct-toolbar-btn" type="button" onClick={handleResetInputs} disabled={loading}>Reset Inputs</button>
          <button className="direct-toolbar-btn" type="button" onClick={handleClearResults} disabled={loading || (!sections.length && !error)}>Clear Results</button>
        </div>
        <div className="direct-shell-status"><FreshnessIndicator freshness={freshness} label="Lookup freshness" staleLabel="Open again to refresh" /></div>
      </div>

      <CollapsibleInfoPanel title="When to use direct access" eyebrow="Example workflows" className="direct-section direct-info-panel">
        <div className="info-card-grid">
          <article className="info-card"><div className="info-card__copy"><strong>Quick subscription posture check</strong><p>List VMs, AKS clusters, storage accounts, or RBAC assignments directly from the active subscription.</p></div></article>
          <article className="info-card"><div className="info-card__copy"><strong>Drill into a known storage account</strong><p>Use the Storage Containers or Storage Blobs lookup when you already know the account and resource group.</p></div></article>
          <article className="info-card"><div className="info-card__copy"><strong>Stay read-only</strong><p>When authorization fails, capture the smallest permission gap and keep the workflow on read-only operations.</p></div></article>
        </div>
      </CollapsibleInfoPanel>

      {error && <SvcState variant="error" error={error} />}

      <div className="direct-main-layout">
        <div className="direct-service-pane">
          <div className="direct-pane-head"><div><span className="direct-pane-kicker">Service inventory</span><h3>Lookup targets</h3></div><span className="direct-pane-summary">{SERVICE_DEFINITIONS.length} total</span></div>
          <div className="direct-service-list">
            {SERVICE_DEFINITIONS.map((entry) => {
              const isActive = entry.key === selectedService
              const entryFilled = fieldValueCount(entry, form)
              return (
                <button key={entry.key} type="button" className={`direct-service-row ${isActive ? 'active' : ''}`} onClick={() => handleSelectService(entry.key)}>
                  <div className="direct-service-row-top">
                    <div className="direct-service-row-copy"><strong>{entry.label}</strong><span>{entry.description}</span></div>
                    <span className={`tf-status-badge ${isActive ? 'info' : 'success'}`}>{entry.fields.length === 0 ? 'auto' : `${entry.fields.length} fields`}</span>
                  </div>
                  <div className="direct-service-row-meta"><span>{entry.key}</span><span>{entry.fields.length} field{entry.fields.length === 1 ? '' : 's'}</span>{entry.fields.length > 0 && <span>{entryFilled}/{entry.fields.length} filled</span>}</div>
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
                <div className="direct-detail-meta-pill"><span>Required</span><strong>{definition.fields.filter((f) => f.required).length || 'None'}</strong></div>
                <div className="direct-detail-meta-pill"><span>Total fields</span><strong>{definition.fields.length || 'Auto'}</strong></div>
                <div className="direct-detail-meta-pill"><span>Ready state</span><strong>{openDisabled ? (subscriptionId ? 'Needs identifiers' : 'Needs subscription') : 'Ready to open'}</strong></div>
                <div className="direct-detail-meta-pill"><span>Payloads</span><strong>{sections.length || 'None yet'}</strong></div>
              </div>
            </div>
            <div className="direct-detail-stats">
              <div className={`direct-detail-stat-card ${openDisabled ? 'warning' : 'success'}`}><span>Request posture</span><strong>{openDisabled ? 'Incomplete' : 'Ready'}</strong><small>{openDisabled ? (subscriptionId ? 'At least one required identifier is missing.' : 'Select an Azure subscription to continue.') : 'All required identifiers are present.'}</small></div>
              <div className="direct-detail-stat-card"><span>Scope</span><strong>{subscriptionLabel || subscriptionId || 'No subscription'}</strong><small>{location ? `Location: ${location}` : 'No location set'}</small></div>
            </div>
          </section>

          <section className="direct-section">
            <div className="direct-section-head"><div><span className="direct-pane-kicker">Parameters</span><h3>Known identifiers</h3></div></div>
            {definition.fields.length > 0 ? (
              <div className="direct-form-grid">
                {definition.fields.map((field) => (
                  <label key={field.key} className="direct-field">
                    <span>{field.label}{field.required ? <em>Required</em> : <em>Optional</em>}</span>
                    <input value={form[field.key] ?? ''} onChange={(e) => updateField(field.key, e.target.value)} placeholder={field.placeholder} />
                  </label>
                ))}
              </div>
            ) : (
              <div className="direct-smart-grid">
                <SvcState variant="empty" message={`This service uses automatic parameters from the active subscription${location ? ` and location (${location})` : ''}. No manual input is required.`} />
              </div>
            )}
          </section>

          {accessDenied && (
            <section className="direct-section direct-permission-panel">
              <div className="direct-section-head"><div><span className="direct-pane-kicker">Permission guidance</span><h3>Authorization failed</h3></div></div>
              <p className="direct-playbook-description">The lookup hit an authorization boundary. Keep the workflow read-only and request only the narrowest missing permission.</p>
              {permissionHints.length ? <div className="direct-hint-list">{permissionHints.map((hint) => <span key={hint}>{hint}</span>)}</div> : <SvcState variant="empty" message="No target-specific permission hints are available for this lookup yet." />}
            </section>
          )}

          <CollapsibleInfoPanel title="Continue in a service console" eyebrow="Next actions" className="direct-section direct-info-panel">
            <div className="info-card-grid">
              <article className="info-card info-card-action"><div className="info-card__copy"><strong>Open Compare</strong><p>Compare Azure posture across subscriptions and Terraform state.</p></div><div className="button-row"><button type="button" className="accent" onClick={onOpenCompare}>Open</button></div></article>
              <article className="info-card info-card-action"><div className="info-card__copy"><strong>Open Compliance</strong><p>Run compliance checks against the active subscription scope.</p></div><div className="button-row"><button type="button" className="accent" onClick={onOpenCompliance}>Open</button></div></article>
              <article className="info-card info-card-action"><div className="info-card__copy"><strong>Open Terraform</strong><p>Inspect the shared Terraform workspace for azurerm resources.</p></div><div className="button-row"><button type="button" className="accent" onClick={() => onNavigate('terraform')}>Open</button></div></article>
              <article className="info-card info-card-action"><div className="info-card__copy"><strong>Azure Portal</strong><p>Open the Azure Portal in an external browser.</p></div><div className="button-row"><button type="button" className="accent" onClick={() => void openExternalUrl(azurePortalUrl())}>Open</button></div></article>
            </div>
          </CollapsibleInfoPanel>

          <section className="direct-section">
            <div className="direct-section-head"><div><span className="direct-pane-kicker">Response</span><h3>Lookup output</h3></div></div>
            {!sections.length ? loading ? <SvcState variant="loading" resourceName="resource data" message="Opening resource and gathering payloads..." /> : <SvcState variant="empty" message="Select a service and open the resource to load results." /> : (
              <div className="direct-result-layout">
                <div className="direct-result-list">{sections.map((section, index) => <button key={`${section.title}:${index}`} type="button" className={`direct-result-row ${index === selectedSectionIndex ? 'active' : ''}`} onClick={() => setSelectedSectionIndex(index)}><strong>{section.title}</strong><span>{summarizeSectionData(section.data)}</span></button>)}</div>
                <div className="direct-result-viewer">{selectedSection ? <><div className="direct-result-viewer-head"><div><span className="direct-pane-kicker">Selected payload</span><h3>{selectedSection.title}</h3></div><span className="direct-result-summary">{summarizeSectionData(selectedSection.data)}</span></div><pre className="svc-code direct-result-code">{pretty(selectedSection.data)}</pre></> : <SvcState variant="no-selection" resourceName="result section" />}</div>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
