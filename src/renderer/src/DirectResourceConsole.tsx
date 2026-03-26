import { useMemo, useState } from 'react'

import type { AwsConnection, WafScope } from '@shared/types'
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

export function DirectResourceConsole({ connection }: { connection: AwsConnection }) {
  const [selectedService, setSelectedService] = useState<DirectServiceKey>('s3')
  const [form, setForm] = useState<Record<string, string>>(INITIAL_FORM)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sections, setSections] = useState<ResultSection[]>([])

  const definition = useMemo(
    () => SERVICE_DEFINITIONS.find((entry) => entry.key === selectedService) ?? SERVICE_DEFINITIONS[0],
    [selectedService]
  )

  function updateField(key: string, value: string): void {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function handleOpen(): Promise<void> {
    setLoading(true)
    setError('')
    setSections([])

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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const openDisabled = definition.fields.some((field) => field.required && !form[field.key]?.trim())

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Direct Access</button>
      </div>

      {error && <div className="svc-error">{error}</div>}

      <div className="svc-panel" style={{ marginBottom: 16 }}>
        <h3>Open Resource Without Listing</h3>
        <p style={{ marginTop: 0, color: '#9ca7b7' }}>
          Use this when the profile can access a specific resource but cannot call the service-wide list API.
        </p>
        <div className="svc-form">
          <label>
            <span>Service</span>
            <select value={selectedService} onChange={(e) => setSelectedService(e.target.value as DirectServiceKey)}>
              {SERVICE_DEFINITIONS.map((entry) => (
                <option key={entry.key} value={entry.key}>{entry.label}</option>
              ))}
            </select>
          </label>
          {definition.fields.map((field) => (
            <label key={field.key}>
              <span>{field.label}</span>
              <input
                value={form[field.key] ?? ''}
                onChange={(e) => updateField(field.key, e.target.value)}
                placeholder={field.placeholder}
              />
            </label>
          ))}
        </div>
        <div className="svc-sidebar-hint" style={{ marginBottom: 10 }}>{definition.description}</div>
        <button className="svc-btn success" type="button" onClick={() => void handleOpen()} disabled={loading || openDisabled}>
          {loading ? 'Opening...' : 'Open Resource'}
        </button>
      </div>

      {!sections.length && !loading && !error && (
        <div className="svc-empty">Enter a known identifier and open the resource directly.</div>
      )}

      {sections.map((section) => (
        <div key={section.title} className="svc-section">
          <h3>{section.title}</h3>
          <pre className="svc-code" style={{ maxHeight: 'calc(100vh - 380px)', overflow: 'auto' }}>{pretty(section.data)}</pre>
        </div>
      ))}
    </div>
  )
}
