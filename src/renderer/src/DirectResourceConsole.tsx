import { useMemo, useState } from 'react'
import './direct-resource.css'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import { CollapsibleInfoPanel } from './CollapsibleInfoPanel'
import { SvcState } from './SvcState'

import type { AwsConnection, NavigationFocus, WafScope } from '@shared/types'
import {
  describeAcmCertificate,
  describeEcsService,
  describeEksCluster,
  describeKmsKey,
  describeRdsCluster,
  describeRdsInstance,
  describeSecret,
  describeWebAcl,
  getLambdaFunction,
  getSecretValue,
  getSnsTopic,
  getSqsQueue,
  listCloudFormationStackResources,
  listEcrImages,
  listEcsTasks,
  listEksNodegroups,
  listRoute53Records,
  listS3Objects,
  listSnsSubscriptions,
  sqsTimeline
} from './api'

type DirectServiceKey =
  | 's3'
  | 'lambda'
  | 'rds-instance'
  | 'rds-cluster'
  | 'ecr'
  | 'ecs'
  | 'eks'
  | 'cloudformation'
  | 'route53'
  | 'secrets-manager'
  | 'sns'
  | 'sqs'
  | 'kms'
  | 'waf'
  | 'acm'

type DirectField = {
  key: string
  label: string
  placeholder: string
  required?: boolean
}

type DirectServiceDefinition = {
  key: DirectServiceKey
  label: string
  description: string
  fields: DirectField[]
}

type ResultSection = {
  title: string
  data: unknown
}

type DirectConsoleLink = {
  label: string
  description: string
  focus: NavigationFocus
}

const SERVICE_DEFINITIONS: DirectServiceDefinition[] = [
  {
    key: 's3',
    label: 'S3 Bucket',
    description: 'Open a bucket directly by name and list the current prefix.',
    fields: [
      { key: 'bucketName', label: 'Bucket Name', placeholder: 'my-bucket', required: true },
      { key: 'prefix', label: 'Prefix', placeholder: 'leave empty for root, or use path/' }
    ]
  },
  {
    key: 'lambda',
    label: 'Lambda Function',
    description: 'Load a function directly by function name.',
    fields: [
      { key: 'functionName', label: 'Function Name', placeholder: 'my-function', required: true }
    ]
  },
  {
    key: 'rds-instance',
    label: 'RDS Instance',
    description: 'Describe an RDS DB instance by identifier.',
    fields: [
      { key: 'dbInstanceIdentifier', label: 'DB Instance Identifier', placeholder: 'prod-db-1', required: true }
    ]
  },
  {
    key: 'rds-cluster',
    label: 'Aurora Cluster',
    description: 'Describe an Aurora or RDS cluster by identifier.',
    fields: [
      { key: 'dbClusterIdentifier', label: 'DB Cluster Identifier', placeholder: 'prod-cluster', required: true }
    ]
  },
  {
    key: 'ecr',
    label: 'ECR Repository',
    description: 'Open a repository directly and list its images.',
    fields: [
      { key: 'repositoryName', label: 'Repository Name', placeholder: 'team/service', required: true }
    ]
  },
  {
    key: 'ecs',
    label: 'ECS Service',
    description: 'Describe an ECS service when you know the cluster and service.',
    fields: [
      { key: 'clusterArn', label: 'Cluster ARN', placeholder: 'arn:aws:ecs:...', required: true },
      { key: 'serviceName', label: 'Service Name', placeholder: 'web', required: true }
    ]
  },
  {
    key: 'eks',
    label: 'EKS Cluster',
    description: 'Describe an EKS cluster directly by name.',
    fields: [
      { key: 'clusterName', label: 'Cluster Name', placeholder: 'prod-eks', required: true }
    ]
  },
  {
    key: 'cloudformation',
    label: 'CloudFormation Stack',
    description: 'List resources for a stack when you know the stack name.',
    fields: [
      { key: 'stackName', label: 'Stack Name', placeholder: 'network-stack', required: true }
    ]
  },
  {
    key: 'route53',
    label: 'Route53 Hosted Zone',
    description: 'List records for a hosted zone by zone id.',
    fields: [
      { key: 'hostedZoneId', label: 'Hosted Zone ID', placeholder: 'Z1234567890ABC', required: true }
    ]
  },
  {
    key: 'secrets-manager',
    label: 'Secrets Manager Secret',
    description: 'Load a secret directly by ARN or name.',
    fields: [
      { key: 'secretId', label: 'Secret ID / ARN', placeholder: 'arn:aws:secretsmanager:... or secret-name', required: true }
    ]
  },
  {
    key: 'sns',
    label: 'SNS Topic',
    description: 'Load a topic directly by ARN.',
    fields: [
      { key: 'topicArn', label: 'Topic ARN', placeholder: 'arn:aws:sns:...', required: true }
    ]
  },
  {
    key: 'sqs',
    label: 'SQS Queue',
    description: 'Load a queue directly by URL.',
    fields: [
      { key: 'queueUrl', label: 'Queue URL', placeholder: 'https://sqs....amazonaws.com/.../queue', required: true }
    ]
  },
  {
    key: 'kms',
    label: 'KMS Key',
    description: 'Describe a KMS key by id, ARN, or alias.',
    fields: [
      { key: 'keyId', label: 'Key ID / ARN / Alias', placeholder: 'alias/my-key or arn:aws:kms:...', required: true }
    ]
  },
  {
    key: 'waf',
    label: 'WAF Web ACL',
    description: 'Describe a web ACL when you know scope, id, and name.',
    fields: [
      { key: 'scope', label: 'Scope', placeholder: 'REGIONAL or CLOUDFRONT', required: true },
      { key: 'id', label: 'Web ACL ID', placeholder: '12345678-....', required: true },
      { key: 'name', label: 'Web ACL Name', placeholder: 'main-acl', required: true }
    ]
  },
  {
    key: 'acm',
    label: 'ACM Certificate',
    description: 'Describe a certificate directly by ARN.',
    fields: [
      { key: 'certificateArn', label: 'Certificate ARN', placeholder: 'arn:aws:acm:...', required: true }
    ]
  }
]

const INITIAL_FORM: Record<string, string> = {
  bucketName: '',
  prefix: '',
  functionName: '',
  dbInstanceIdentifier: '',
  dbClusterIdentifier: '',
  repositoryName: '',
  clusterArn: '',
  serviceName: '',
  clusterName: '',
  stackName: '',
  hostedZoneId: '',
  secretId: '',
  topicArn: '',
  queueUrl: '',
  keyId: '',
  scope: 'REGIONAL',
  id: '',
  name: '',
  certificateArn: ''
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function normalizeS3Prefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed || trimmed === '/') {
    return ''
  }
  return trimmed.replace(/^\/+/, '')
}

function fieldValueCount(definition: DirectServiceDefinition, form: Record<string, string>): number {
  return definition.fields.filter((field) => form[field.key]?.trim()).length
}

function requiredFieldCount(definition: DirectServiceDefinition): number {
  return definition.fields.filter((field) => field.required).length
}

function summarizeSectionData(data: unknown): string {
  if (Array.isArray(data)) {
    return `${data.length} item${data.length === 1 ? '' : 's'}`
  }

  if (data && typeof data === 'object') {
    return `${Object.keys(data as Record<string, unknown>).length} field${Object.keys(data as Record<string, unknown>).length === 1 ? '' : 's'}`
  }

  if (typeof data === 'string') {
    return data.length > 80 ? `${data.length} chars` : data
  }

  if (data === null || data === undefined) {
    return 'Empty payload'
  }

  return typeof data
}

export function DirectResourceConsole({
  connection,
  onNavigate
}: {
  connection: AwsConnection
  onNavigate: (focus: NavigationFocus) => void
}) {
  const [selectedService, setSelectedService] = useState<DirectServiceKey>('s3')
  const [form, setForm] = useState<Record<string, string>>(INITIAL_FORM)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sections, setSections] = useState<ResultSection[]>([])
  const [selectedSectionIndex, setSelectedSectionIndex] = useState(0)
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh,
    replaceFetchedAt
  } = useFreshnessState({ staleAfterMs: 10 * 60 * 1000 })

  const definition = useMemo(
    () => SERVICE_DEFINITIONS.find((entry) => entry.key === selectedService) ?? SERVICE_DEFINITIONS[0],
    [selectedService]
  )
  const selectedSection = sections[selectedSectionIndex] ?? null
  const populatedFieldCount = fieldValueCount(definition, form)
  const requiredCount = requiredFieldCount(definition)
  const connectionLabel = connection.kind === 'profile' ? connection.profile : connection.label
  const connectionMode = connection.kind === 'profile' ? 'Profile' : 'Assumed role'
  const suggestedLinks = useMemo<DirectConsoleLink[]>(() => {
    switch (selectedService) {
      case 'lambda':
        return form.functionName.trim()
          ? [{
              label: 'Open Lambda console',
              description: 'Continue in the main Lambda workspace with focus applied.',
              focus: { service: 'lambda', functionName: form.functionName.trim() }
            }]
          : []
      case 'ecs':
        return form.clusterArn.trim() && form.serviceName.trim()
          ? [{
              label: 'Open ECS service',
              description: 'Jump into ECS with the selected cluster and service.',
              focus: { service: 'ecs', clusterArn: form.clusterArn.trim(), serviceName: form.serviceName.trim() }
            }]
          : []
      case 'eks':
        return form.clusterName.trim()
          ? [{
              label: 'Open EKS cluster',
              description: 'Continue in the EKS workspace with the cluster preselected.',
              focus: { service: 'eks', clusterName: form.clusterName.trim() }
            }]
          : []
      case 'waf':
        return form.name.trim()
          ? [{
              label: 'Open WAF console',
              description: 'Review the Web ACL inside the main WAF workspace.',
              focus: { service: 'waf', webAclName: form.name.trim() }
            }]
          : []
      default:
        return []
    }
  }, [form.clusterArn, form.clusterName, form.functionName, form.name, form.serviceName, selectedService])

  function updateField(key: string, value: string): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function handleSelectService(key: DirectServiceKey): void {
    setSelectedService(key)
    setError('')
    setSections([])
    setSelectedSectionIndex(0)
    replaceFetchedAt(null)
  }

  function handleResetInputs(): void {
    setForm(INITIAL_FORM)
  }

  function handleClearResults(): void {
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
      switch (selectedService) {
        case 's3': {
          const bucketName = form.bucketName.trim()
          const prefix = normalizeS3Prefix(form.prefix)
          nextSections = [
            {
              title: `Bucket ${bucketName}`,
              data: await listS3Objects(connection, bucketName, prefix)
            }
          ]
          break
        }
        case 'lambda': {
          nextSections = [
            {
              title: form.functionName.trim(),
              data: await getLambdaFunction(connection, form.functionName.trim())
            }
          ]
          break
        }
        case 'rds-instance': {
          nextSections = [
            {
              title: form.dbInstanceIdentifier.trim(),
              data: await describeRdsInstance(connection, form.dbInstanceIdentifier.trim())
            }
          ]
          break
        }
        case 'rds-cluster': {
          nextSections = [
            {
              title: form.dbClusterIdentifier.trim(),
              data: await describeRdsCluster(connection, form.dbClusterIdentifier.trim())
            }
          ]
          break
        }
        case 'ecr': {
          nextSections = [
            {
              title: `Repository ${form.repositoryName.trim()}`,
              data: await listEcrImages(connection, form.repositoryName.trim())
            }
          ]
          break
        }
        case 'ecs': {
          const clusterArn = form.clusterArn.trim()
          const serviceName = form.serviceName.trim()
          const [service, tasks] = await Promise.all([
            describeEcsService(connection, clusterArn, serviceName),
            listEcsTasks(connection, clusterArn, serviceName)
          ])
          nextSections = [
            { title: `Service ${serviceName}`, data: service },
            { title: 'Tasks', data: tasks }
          ]
          break
        }
        case 'eks': {
          const clusterName = form.clusterName.trim()
          const [detail, nodegroups] = await Promise.all([
            describeEksCluster(connection, clusterName),
            listEksNodegroups(connection, clusterName)
          ])
          nextSections = [
            { title: `Cluster ${clusterName}`, data: detail },
            { title: 'Nodegroups', data: nodegroups }
          ]
          break
        }
        case 'cloudformation': {
          nextSections = [
            {
              title: `Stack ${form.stackName.trim()}`,
              data: await listCloudFormationStackResources(connection, form.stackName.trim())
            }
          ]
          break
        }
        case 'route53': {
          nextSections = [
            {
              title: `Hosted Zone ${form.hostedZoneId.trim()}`,
              data: await listRoute53Records(connection, form.hostedZoneId.trim())
            }
          ]
          break
        }
        case 'secrets-manager': {
          const secretId = form.secretId.trim()
          const [detail, value] = await Promise.all([
            describeSecret(connection, secretId),
            getSecretValue(connection, secretId)
          ])
          nextSections = [
            { title: 'Secret Detail', data: detail },
            { title: 'Current Value', data: value }
          ]
          break
        }
        case 'sns': {
          const topicArn = form.topicArn.trim()
          const [topic, subscriptions] = await Promise.all([
            getSnsTopic(connection, topicArn),
            listSnsSubscriptions(connection, topicArn)
          ])
          nextSections = [
            { title: 'Topic', data: topic },
            { title: 'Subscriptions', data: subscriptions }
          ]
          break
        }
        case 'sqs': {
          const queueUrl = form.queueUrl.trim()
          const [queue, timeline] = await Promise.all([
            getSqsQueue(connection, queueUrl),
            sqsTimeline(connection, queueUrl)
          ])
          nextSections = [
            { title: 'Queue', data: queue },
            { title: 'Timeline', data: timeline }
          ]
          break
        }
        case 'kms': {
          nextSections = [
            {
              title: form.keyId.trim(),
              data: await describeKmsKey(connection, form.keyId.trim())
            }
          ]
          break
        }
        case 'waf': {
          nextSections = [
            {
              title: form.name.trim(),
              data: await describeWebAcl(
                connection,
                form.scope.trim().toUpperCase() as WafScope,
                form.id.trim(),
                form.name.trim()
              )
            }
          ]
          break
        }
        case 'acm': {
          nextSections = [
            {
              title: form.certificateArn.trim(),
              data: await describeAcmCertificate(connection, form.certificateArn.trim())
            }
          ]
          break
        }
      }

      setSections(nextSections)
      completeRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      failRefresh()
    } finally {
      setLoading(false)
    }
  }

  const openDisabled = definition.fields.some((field) => field.required && !form[field.key]?.trim())

  return (
    <div className="svc-console direct-console">
      <section className="direct-shell-hero">
        <div className="direct-shell-copy">
          <div className="eyebrow">Direct resource access</div>
          <h2>{definition.label}</h2>
          <p>Open a known AWS resource by identifier when list-level permissions are blocked or too broad for the task.</p>
          <div className="direct-shell-meta-strip">
            <div className="direct-shell-meta-pill">
              <span>Connection</span>
              <strong>{connectionLabel}</strong>
            </div>
            <div className="direct-shell-meta-pill">
              <span>Mode</span>
              <strong>{connectionMode}</strong>
            </div>
            <div className="direct-shell-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="direct-shell-meta-pill">
              <span>Lookup</span>
              <strong>{requiredCount} required fields</strong>
            </div>
          </div>
        </div>
        <div className="direct-shell-stats">
          <div className="direct-shell-stat-card direct-shell-stat-card-accent">
            <span>Services</span>
            <strong>{SERVICE_DEFINITIONS.length}</strong>
            <small>Direct lookups available in this console</small>
          </div>
          <div className="direct-shell-stat-card">
            <span>Inputs ready</span>
            <strong>{populatedFieldCount}/{definition.fields.length}</strong>
            <small>{openDisabled ? 'Complete the required identifiers' : 'Current request is ready to open'}</small>
          </div>
          <div className="direct-shell-stat-card">
            <span>Result sections</span>
            <strong>{sections.length}</strong>
            <small>{sections.length ? 'Structured payloads returned from AWS' : 'No payload loaded yet'}</small>
          </div>
          <div className="direct-shell-stat-card">
            <span>Selected view</span>
            <strong>{selectedSection?.title || 'Standby'}</strong>
            <small>{selectedSection ? summarizeSectionData(selectedSection.data) : 'Open a resource to inspect details'}</small>
          </div>
        </div>
      </section>

      <div className="direct-shell-toolbar">
        <div className="direct-toolbar">
          <button className="direct-toolbar-btn accent" type="button" onClick={() => void handleOpen()} disabled={loading || openDisabled}>
            {loading ? 'Opening...' : 'Open Resource'}
          </button>
          <button className="direct-toolbar-btn" type="button" onClick={handleResetInputs} disabled={loading}>
            Reset Inputs
          </button>
          <button className="direct-toolbar-btn" type="button" onClick={handleClearResults} disabled={loading || (!sections.length && !error)}>
            Clear Results
          </button>
        </div>
        <div className="direct-shell-status">
          <FreshnessIndicator freshness={freshness} label="Lookup freshness" staleLabel="Open again to refresh" />
        </div>
      </div>

      <CollapsibleInfoPanel title="When to use direct access" eyebrow="Example workflows" className="direct-section direct-info-panel">
        <div className="info-card-grid">
          <article className="info-card">
            <div className="info-card__copy">
              <strong>Known resource, limited list permissions</strong>
              <p>Open a Lambda, ECS service, or secret directly when broad inventory listing is blocked but you already know the identifier.</p>
            </div>
          </article>
          <article className="info-card">
            <div className="info-card__copy">
              <strong>Incident triage from an ARN or URL</strong>
              <p>Paste the resource identifier from a ticket, alert, or audit finding and inspect the payload before jumping into the full console.</p>
            </div>
          </article>
          <article className="info-card">
            <div className="info-card__copy">
              <strong>Fast handoff into a deeper workspace</strong>
              <p>Use the routed next actions below to move from a one-off lookup into the main service console with focus applied.</p>
            </div>
          </article>
        </div>
      </CollapsibleInfoPanel>

      {error && <SvcState variant="error" error={error} />}

      <div className="direct-main-layout">
        <div className="direct-service-pane">
          <div className="direct-pane-head">
            <div>
              <span className="direct-pane-kicker">Service inventory</span>
              <h3>Lookup targets</h3>
            </div>
            <span className="direct-pane-summary">{SERVICE_DEFINITIONS.length} total</span>
          </div>
          <div className="direct-service-list">
            {SERVICE_DEFINITIONS.map((entry) => {
              const isActive = entry.key === selectedService
              const entryRequired = requiredFieldCount(entry)
              const entryFilled = fieldValueCount(entry, form)
              return (
                <button
                  key={entry.key}
                  type="button"
                  className={`direct-service-row ${isActive ? 'active' : ''}`}
                  onClick={() => handleSelectService(entry.key)}
                >
                  <div className="direct-service-row-top">
                    <div className="direct-service-row-copy">
                      <strong>{entry.label}</strong>
                      <span>{entry.description}</span>
                    </div>
                    <span className={`tf-status-badge ${isActive ? 'info' : 'success'}`}>{entryRequired} required</span>
                  </div>
                  <div className="direct-service-row-meta">
                    <span>{entry.key}</span>
                    <span>{entry.fields.length} field{entry.fields.length === 1 ? '' : 's'}</span>
                    <span>{entryFilled}/{entry.fields.length} filled</span>
                  </div>
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
                <div className="direct-detail-meta-pill">
                  <span>Required</span>
                  <strong>{requiredCount}</strong>
                </div>
                <div className="direct-detail-meta-pill">
                  <span>Total fields</span>
                  <strong>{definition.fields.length}</strong>
                </div>
                <div className="direct-detail-meta-pill">
                  <span>Ready state</span>
                  <strong>{openDisabled ? 'Needs identifiers' : 'Ready to open'}</strong>
                </div>
                <div className="direct-detail-meta-pill">
                  <span>Payloads</span>
                  <strong>{sections.length || 'None yet'}</strong>
                </div>
              </div>
            </div>
            <div className="direct-detail-stats">
              <div className={`direct-detail-stat-card ${openDisabled ? 'warning' : 'success'}`}>
                <span>Request posture</span>
                <strong>{openDisabled ? 'Incomplete' : 'Ready'}</strong>
                <small>{openDisabled ? 'At least one required identifier is missing.' : 'All required identifiers are present.'}</small>
              </div>
              <div className="direct-detail-stat-card">
                <span>Primary key</span>
                <strong>{definition.fields[0]?.label || 'N/A'}</strong>
                <small>{definition.fields[0]?.placeholder || 'No placeholder available'}</small>
              </div>
            </div>
          </section>

          <section className="direct-section">
            <div className="direct-section-head">
              <div>
                <span className="direct-pane-kicker">Parameters</span>
                <h3>Known identifiers</h3>
              </div>
            </div>
            <div className="direct-form-grid">
              <label className="direct-field direct-field-wide">
                <span>Service</span>
                <select value={selectedService} onChange={(e) => handleSelectService(e.target.value as DirectServiceKey)}>
                  {SERVICE_DEFINITIONS.map((entry) => (
                    <option key={entry.key} value={entry.key}>{entry.label}</option>
                  ))}
                </select>
              </label>
              {definition.fields.map((field) => (
                <label key={field.key} className="direct-field">
                  <span>
                    {field.label}
                    {field.required ? <em>Required</em> : <em>Optional</em>}
                  </span>
                  <input
                    value={form[field.key] ?? ''}
                    onChange={(e) => updateField(field.key, e.target.value)}
                    placeholder={field.placeholder}
                  />
                </label>
              ))}
            </div>
          </section>

          <CollapsibleInfoPanel title="Continue in a service console" eyebrow="Next actions" className="direct-section direct-info-panel">
            {suggestedLinks.length > 0 ? (
              <div className="info-card-grid">
                {suggestedLinks.map((link) => (
                  <article key={`${link.label}:${link.focus.service}`} className="info-card info-card-action">
                    <div className="info-card__copy">
                      <strong>{link.label}</strong>
                      <p>{link.description}</p>
                    </div>
                    <div className="button-row">
                      <button type="button" className="accent" onClick={() => onNavigate(link.focus)}>
                        Open
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <SvcState
                variant="empty"
                message="Open a supported direct lookup to unlock a routed next action into the main console."
              />
            )}
          </CollapsibleInfoPanel>

          <section className="direct-section">
            <div className="direct-section-head">
              <div>
                <span className="direct-pane-kicker">Response</span>
                <h3>Lookup output</h3>
              </div>
            </div>
            {!sections.length ? (
              loading ? (
                <SvcState variant="loading" resourceName="resource data" message="Opening resource and gathering payloads..." />
              ) : (
                <SvcState variant="empty" message="Enter a known identifier and open the resource directly." />
              )
            ) : (
              <div className="direct-result-layout">
                <div className="direct-result-list">
                  {sections.map((section, index) => (
                    <button
                      key={`${section.title}:${index}`}
                      type="button"
                      className={`direct-result-row ${index === selectedSectionIndex ? 'active' : ''}`}
                      onClick={() => setSelectedSectionIndex(index)}
                    >
                      <strong>{section.title}</strong>
                      <span>{summarizeSectionData(section.data)}</span>
                    </button>
                  ))}
                </div>
                <div className="direct-result-viewer">
                  {selectedSection ? (
                    <>
                      <div className="direct-result-viewer-head">
                        <div>
                          <span className="direct-pane-kicker">Selected payload</span>
                          <h3>{selectedSection.title}</h3>
                        </div>
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
    </div>
  )
}
