import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetResourcePolicyCommand,
  GetSecretValueCommand,
  ListSecretVersionIdsCommand,
  ListSecretsCommand,
  PutResourcePolicyCommand,
  RestoreSecretCommand,
  RotateSecretCommand,
  SecretsManagerClient,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateSecretCommand
} from '@aws-sdk/client-secrets-manager'
import {
  DescribeTaskDefinitionCommand,
  ECSClient
} from '@aws-sdk/client-ecs'

import type {
  AwsConnection,
  SecretCreateInput,
  SecretDependencyConfidence,
  SecretDependencyEvidence,
  SecretDependencyItem,
  SecretDependencyReport,
  SecretDependencyRisk,
  SecretTag,
  SecretsManagerSecretDetail,
  SecretsManagerSecretSummary,
  SecretsManagerSecretValue
} from '@shared/types'
import { getAwsClient, readTags } from './client'
import { listServices, listClusters } from './ecs'
import { listLambdaFunctions, getLambdaFunctionDetails } from './lambda'
import { listEksClusters, createTempEksKubeconfig } from './eks'
import { spawn } from 'node:child_process'
import { getConnectionEnv } from '../sessionHub'
import { logWarn } from '../observability'



function toIso(value: Date | undefined): string {
  return value ? value.toISOString() : ''
}

function normalizeTags(tags: SecretTag[]) {
  return tags.filter((tag) => tag.key.trim()).map((tag) => ({ Key: tag.key.trim(), Value: tag.value }))
}

function normalizeMatchValue(value: string): string {
  return value.trim().toLowerCase()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compactArn(arn: string): string {
  const parts = arn.split(':')
  if (parts.length < 7) return arn
  const resource = parts.slice(5).join(':')
  const secretName = resource.startsWith('secret:') ? resource.slice('secret:'.length) : resource
  const suffixMatch = secretName.match(/^(.*)-[A-Za-z0-9]{6}$/)
  return suffixMatch ? suffixMatch[1] : secretName
}

function matchReference(
  value: string,
  field: string,
  directArn: string,
  secretName: string,
  compactSecretName: string
): { confidence: SecretDependencyConfidence; evidence: SecretDependencyEvidence } | null {
  const normalizedValue = normalizeMatchValue(value)
  if (!normalizedValue) return null

  if (normalizedValue.includes(normalizeMatchValue(directArn))) {
    return {
      confidence: 'high',
      evidence: {
        kind: 'direct-arn-reference',
        field,
        summary: 'Configuration contains the full secret ARN.'
      }
    }
  }

  const exactNamePattern = new RegExp(`(^|[^a-z0-9/_-])${escapeRegExp(normalizeMatchValue(secretName))}([^a-z0-9/_-]|$)`)
  if (exactNamePattern.test(normalizedValue)) {
    return {
      confidence: field.includes('secret') || field.includes('valueFrom') ? 'high' : 'medium',
      evidence: {
        kind: 'name-reference',
        field,
        summary: 'Configuration contains the secret name.'
      }
    }
  }

  if (compactSecretName && compactSecretName !== normalizeMatchValue(secretName)) {
    const compactPattern = new RegExp(`(^|[^a-z0-9/_-])${escapeRegExp(compactSecretName)}([^a-z0-9/_-]|$)`)
    if (compactPattern.test(normalizedValue)) {
      return {
        confidence: 'low',
        evidence: {
          kind: 'name-reference',
          field,
          summary: 'Configuration contains the shortened secret identifier.'
        }
      }
    }
  }

  return null
}

function confidenceRank(confidence: SecretDependencyConfidence): number {
  if (confidence === 'high') return 3
  if (confidence === 'medium') return 2
  return 1
}

function strongerConfidence(
  current: SecretDependencyConfidence,
  candidate: SecretDependencyConfidence
): SecretDependencyConfidence {
  return confidenceRank(candidate) > confidenceRank(current) ? candidate : current
}

function buildRiskList(detail: SecretsManagerSecretDetail, dependencyCount: number): SecretDependencyRisk[] {
  const risks: SecretDependencyRisk[] = []
  if (!detail.rotationEnabled) {
    risks.push({
      id: 'rotation-disabled',
      level: 'warning',
      title: 'Rotation disabled',
      detail: 'Automatic rotation is not enabled for this secret.'
    })
  }

  if (detail.lastAccessedDate) {
    const lastAccessedMs = Date.parse(detail.lastAccessedDate)
    const daysSinceAccess = Number.isNaN(lastAccessedMs)
      ? 0
      : Math.floor((Date.now() - lastAccessedMs) / (1000 * 60 * 60 * 24))
    if (daysSinceAccess >= 90) {
      risks.push({
        id: 'stale-access',
        level: 'warning',
        title: 'Not accessed recently',
        detail: `AWS last accessed metadata is ${daysSinceAccess} days old.`
      })
    }
  }

  if (dependencyCount === 0) {
    risks.push({
      id: 'appears-unused',
      level: 'info',
      title: 'No likely consumers found',
      detail: 'The current scan did not find likely Lambda, ECS, or EKS consumers.'
    })
  }

  if (dependencyCount >= 5) {
    risks.push({
      id: 'many-consumers',
      level: 'critical',
      title: 'Widely shared secret',
      detail: `This secret appears to be used by ${dependencyCount} consumers, increasing blast radius during rotation or deletion.`
    })
  }

  return risks
}

async function runKubectlJson(
  connection: AwsConnection,
  clusterName: string,
  command: string
): Promise<string> {
  const kubeconfig = await createTempEksKubeconfig(connection, clusterName)

  return await new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      env: {
        ...process.env,
        ...getConnectionEnv(connection),
        KUBECONFIG: kubeconfig.path
      }
    })

    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      output += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output)
        return
      }

      reject(new Error(output.trim() || `kubectl exited with code ${code ?? -1}`))
    })
  })
}

type MutableDependency = {
  item: SecretDependencyItem
}

function upsertDependency(
  items: Map<string, MutableDependency>,
  candidate: SecretDependencyItem
): void {
  const existing = items.get(candidate.id)
  if (!existing) {
    items.set(candidate.id, { item: candidate })
    return
  }

  existing.item.evidence.push(...candidate.evidence)
  existing.item.confidence = strongerConfidence(existing.item.confidence, candidate.confidence)
  if (existing.item.signal !== 'confirmed' && candidate.signal === 'confirmed') {
    existing.item.signal = 'confirmed'
  }
}

export async function listSecrets(connection: AwsConnection): Promise<SecretsManagerSecretSummary[]> {
  const client = getAwsClient(SecretsManagerClient, connection)
  const items: SecretsManagerSecretSummary[] = []
  let nextToken: string | undefined

  do {
    const response = await client.send(new ListSecretsCommand({ NextToken: nextToken, IncludePlannedDeletion: true }))
    for (const secret of response.SecretList ?? []) {
      items.push({
        arn: secret.ARN ?? '',
        name: secret.Name ?? '',
        description: secret.Description ?? '',
        owningService: secret.OwningService ?? '',
        primaryRegion: secret.PrimaryRegion ?? '',
        rotationEnabled: Boolean(secret.RotationEnabled),
        deletedDate: toIso(secret.DeletedDate),
        lastChangedDate: toIso(secret.LastChangedDate),
        lastAccessedDate: toIso(secret.LastAccessedDate),
        versionCount: secret.SecretVersionsToStages ? Object.keys(secret.SecretVersionsToStages).length : 0,
        tags: readTags(secret.Tags)
      })
    }
    nextToken = response.NextToken
  } while (nextToken)

  return items
}

export async function describeSecret(connection: AwsConnection, secretId: string): Promise<SecretsManagerSecretDetail> {
  const client = getAwsClient(SecretsManagerClient, connection)
  const [detail, versions, policy] = await Promise.all([
    client.send(new DescribeSecretCommand({ SecretId: secretId })),
    client.send(new ListSecretVersionIdsCommand({ SecretId: secretId, IncludeDeprecated: true })),
    client.send(new GetResourcePolicyCommand({ SecretId: secretId })).catch(() => ({ ResourcePolicy: '' }))
  ])

  return {
    arn: detail.ARN ?? '',
    name: detail.Name ?? '',
    description: detail.Description ?? '',
    kmsKeyId: detail.KmsKeyId ?? '',
    owningService: detail.OwningService ?? '',
    primaryRegion: detail.PrimaryRegion ?? '',
    rotationEnabled: Boolean(detail.RotationEnabled),
    rotationLambdaArn: detail.RotationLambdaARN ?? '',
    deletedDate: toIso(detail.DeletedDate),
    lastChangedDate: toIso(detail.LastChangedDate),
    lastAccessedDate: toIso(detail.LastAccessedDate),
    nextRotationDate: toIso(detail.NextRotationDate),
    tags: readTags(detail.Tags),
    versions: (versions.Versions ?? []).map((version) => ({
      versionId: version.VersionId ?? '',
      createdDate: toIso(version.CreatedDate),
      stages: version.VersionStages ?? [],
      isCurrent: (version.VersionStages ?? []).includes('AWSCURRENT')
    })),
    policy: (policy as { ResourcePolicy?: string }).ResourcePolicy ?? ''
  }
}

export async function getSecretDependencyReport(
  connection: AwsConnection,
  secretId: string
): Promise<SecretDependencyReport> {
  const detail = await describeSecret(connection, secretId)
  const directArn = detail.arn
  const secretName = detail.name
  const compactSecretName = normalizeMatchValue(compactArn(detail.arn))
  const dependencyMap = new Map<string, MutableDependency>()

  const lambdaFunctions = await listLambdaFunctions(connection)
  for (const fn of lambdaFunctions) {
    try {
      const lambdaDetail = await getLambdaFunctionDetails(connection, fn.functionName)
      for (const [key, value] of Object.entries(lambdaDetail.environment)) {
        const match = matchReference(value, `environment.${key}`, directArn, secretName, compactSecretName)
        if (!match) continue

        upsertDependency(dependencyMap, {
          id: `lambda:${lambdaDetail.functionName}`,
          serviceType: 'Lambda',
          resourceName: lambdaDetail.functionName,
          resourceId: lambdaDetail.functionArn || lambdaDetail.functionName,
          region: connection.region,
          evidence: [match.evidence],
          reason: 'Matched Lambda environment configuration.',
          confidence: match.confidence,
          signal: match.confidence === 'high' ? 'confirmed' : 'heuristic',
          navigation: {
            service: 'lambda',
            resourceId: lambdaDetail.functionName,
            clusterArn: '',
            clusterName: '',
            serviceName: '',
            region: connection.region
          }
        })
      }
    } catch (error) {
      logWarn('secrets-manager.dependency-probe.lambda', 'Failed to probe Lambda function for secret dependency.', { region: connection.region }, error)
      continue
    }
  }

  const ecsClient = getAwsClient(ECSClient, connection)
  const clusters = await listClusters(connection)
  for (const cluster of clusters) {
    const services = await listServices(connection, cluster.clusterArn)
    for (const service of services) {
      try {
        const taskDefinition = await ecsClient.send(
          new DescribeTaskDefinitionCommand({ taskDefinition: service.taskDefinition })
        )
        const taskDef = taskDefinition.taskDefinition
        if (!taskDef) continue

        const evidence: SecretDependencyEvidence[] = []
        let confidence: SecretDependencyConfidence = 'low'

        for (const container of taskDef.containerDefinitions ?? []) {
          for (const secret of container.secrets ?? []) {
            const match = matchReference(
              secret.valueFrom ?? '',
              `container.${container.name ?? 'unnamed'}.secrets.${secret.name ?? 'valueFrom'}`,
              directArn,
              secretName,
              compactSecretName
            )
            if (!match) continue
            evidence.push({
              kind: 'task-definition-secret',
              field: match.evidence.field,
              summary: 'Task definition secret injection references this secret.'
            })
            confidence = strongerConfidence(confidence, 'high')
          }

          for (const envVar of container.environment ?? []) {
            const match = matchReference(
              envVar.value ?? '',
              `container.${container.name ?? 'unnamed'}.environment.${envVar.name ?? 'value'}`,
              directArn,
              secretName,
              compactSecretName
            )
            if (!match) continue
            evidence.push(match.evidence)
            confidence = strongerConfidence(confidence, match.confidence)
          }

          const repoMatch = matchReference(
            container.repositoryCredentials?.credentialsParameter ?? '',
            `container.${container.name ?? 'unnamed'}.repositoryCredentials.credentialsParameter`,
            directArn,
            secretName,
            compactSecretName
          )
          if (repoMatch) {
            evidence.push({
              kind: 'repository-credentials',
              field: repoMatch.evidence.field,
              summary: 'Repository credentials reference this secret.'
            })
            confidence = strongerConfidence(confidence, 'high')
          }
        }

        if (!evidence.length) continue

        upsertDependency(dependencyMap, {
          id: `ecs:${cluster.clusterArn}:${service.serviceName}`,
          serviceType: 'ECS Service',
          resourceName: service.serviceName,
          resourceId: service.serviceArn,
          region: connection.region,
          evidence,
          reason: 'Matched ECS task definition or service-linked configuration.',
          confidence,
          signal: confidence === 'high' ? 'confirmed' : 'heuristic',
          navigation: {
            service: 'ecs',
            resourceId: service.serviceArn,
            clusterArn: cluster.clusterArn,
            clusterName: cluster.clusterName,
            serviceName: service.serviceName,
            region: connection.region
          }
        })
      } catch (error) {
        logWarn('secrets-manager.dependency-probe.ecs', 'Failed to probe ECS service for secret dependency.', { region: connection.region }, error)
        continue
      }
    }
  }

  try {
    const clusters = await listEksClusters(connection)
    for (const cluster of clusters) {
      try {
        const rawOutput = await runKubectlJson(
          connection,
          cluster.name,
          'kubectl get deploy,statefulset,daemonset,job,cronjob -A -o json'
        )
        const payload = JSON.parse(rawOutput) as {
          items?: Array<{
            kind?: string
            metadata?: {
              namespace?: string
              name?: string
              annotations?: Record<string, string>
              labels?: Record<string, string>
            }
            spec?: {
              jobTemplate?: {
                spec?: {
                  template?: {
                    spec?: {
                      containers?: Array<{
                        name?: string
                        env?: Array<{
                          name?: string
                          value?: string
                        }>
                      }>
                    }
                  }
                }
              }
              template?: {
                spec?: {
                  containers?: Array<{
                    name?: string
                    env?: Array<{
                      name?: string
                      value?: string
                    }>
                  }>
                }
              }
            }
          }>
        }

        for (const workload of payload.items ?? []) {
          const namespace = workload.metadata?.namespace ?? 'default'
          const workloadName = workload.metadata?.name ?? 'unknown'
          const workloadId = `${namespace}/${workloadName}`
          const podSpec =
            workload.spec?.template?.spec ??
            workload.spec?.jobTemplate?.spec?.template?.spec
          const evidence: SecretDependencyEvidence[] = []
          let confidence: SecretDependencyConfidence = 'low'

          for (const [annotationKey, annotationValue] of Object.entries(workload.metadata?.annotations ?? {})) {
            const match = matchReference(
              annotationValue,
              `metadata.annotations.${annotationKey}`,
              directArn,
              secretName,
              compactSecretName
            )
            if (!match) continue
            evidence.push({
              kind: 'kubectl-config-reference',
              field: match.evidence.field,
              summary: 'Workload metadata references the secret.'
            })
            confidence = strongerConfidence(confidence, match.confidence)
          }

          for (const [labelKey, labelValue] of Object.entries(workload.metadata?.labels ?? {})) {
            const match = matchReference(
              labelValue,
              `metadata.labels.${labelKey}`,
              directArn,
              secretName,
              compactSecretName
            )
            if (!match) continue
            evidence.push({
              kind: 'kubectl-config-reference',
              field: match.evidence.field,
              summary: 'Workload label references the secret.'
            })
            confidence = strongerConfidence(confidence, 'low')
          }

          for (const container of podSpec?.containers ?? []) {
            for (const envVar of container.env ?? []) {
              const match = matchReference(
                envVar.value ?? '',
                `container.${container.name ?? 'unnamed'}.env.${envVar.name ?? 'value'}`,
                directArn,
                secretName,
                compactSecretName
              )
              if (!match) continue
              evidence.push({
                kind: 'kubectl-config-reference',
                field: match.evidence.field,
                summary: 'Workload environment configuration references the secret.'
              })
              confidence = strongerConfidence(confidence, match.confidence)
            }
          }

          if (!evidence.length) continue

          upsertDependency(dependencyMap, {
            id: `eks:${cluster.name}:${workloadId}`,
            serviceType: 'EKS Workload',
            resourceName: workloadId,
            resourceId: workloadId,
            region: connection.region,
            evidence,
            reason: 'Heuristic match from kubectl workload configuration.',
            confidence,
            signal: 'heuristic',
            navigation: {
              service: 'eks',
              resourceId: workloadId,
              clusterArn: '',
              clusterName: cluster.name,
              serviceName: '',
              region: connection.region
            }
          })
        }
      } catch (error) {
        logWarn('secrets-manager.dependency-probe.eks-cluster', 'Failed to probe EKS cluster for secret dependency.', { clusterName: cluster.name, region: connection.region }, error)
        continue
      }
    }
  } catch (error) {
    logWarn('secrets-manager.dependency-probe.eks', 'EKS probing failed; returning partial dependency signals.', { region: connection.region }, error)
  }

  const dependencies = Array.from(dependencyMap.values())
    .map((entry) => ({
      ...entry.item,
      evidence: entry.item.evidence.filter(
        (item, index, list) =>
          list.findIndex((candidate) => candidate.field === item.field && candidate.summary === item.summary) === index
      )
    }))
    .sort((left, right) => {
      const confidenceDelta = confidenceRank(right.confidence) - confidenceRank(left.confidence)
      if (confidenceDelta !== 0) return confidenceDelta
      return left.resourceName.localeCompare(right.resourceName)
    })

  return {
    secretArn: detail.arn,
    secretName: detail.name,
    region: connection.region,
    generatedAt: new Date().toISOString(),
    posture: {
      rotationEnabled: detail.rotationEnabled,
      nextRotationDate: detail.nextRotationDate,
      versionCount: detail.versions.length,
      hasPolicy: Boolean(detail.policy.trim()),
      tags: detail.tags,
      lastAccessedDate: detail.lastAccessedDate
    },
    dependencies,
    risks: buildRiskList(detail, dependencies.length),
    notes: [
      'Dependency detection is heuristic unless the evidence shows a direct ARN or task-definition secret reference.',
      'Only currently loaded AWS services are scanned here: Lambda, ECS, and EKS workload config via kubectl when available.',
      'Secret values are not read during dependency analysis.'
    ]
  }
}

export async function getSecretValue(connection: AwsConnection, secretId: string, versionId?: string): Promise<SecretsManagerSecretValue> {
  const client = getAwsClient(SecretsManagerClient, connection)
  const response = await client.send(new GetSecretValueCommand({ SecretId: secretId, VersionId: versionId || undefined }))

  return {
    secretString: response.SecretString ?? '',
    secretBinary: response.SecretBinary ? Buffer.from(response.SecretBinary as Uint8Array).toString('base64') : '',
    versionId: response.VersionId ?? '',
    versionStages: response.VersionStages ?? [],
    createdDate: ''
  }
}

export async function createSecret(connection: AwsConnection, input: SecretCreateInput): Promise<string> {
  const client = getAwsClient(SecretsManagerClient, connection)
  const response = await client.send(
    new CreateSecretCommand({
      Name: input.name,
      Description: input.description || undefined,
      SecretString: input.secretString,
      KmsKeyId: input.kmsKeyId || undefined,
      Tags: normalizeTags(input.tags)
    })
  )

  return response.ARN ?? ''
}

export async function deleteSecret(connection: AwsConnection, secretId: string, forceDeleteWithoutRecovery: boolean): Promise<void> {
  const client = getAwsClient(SecretsManagerClient, connection)
  await client.send(
    new DeleteSecretCommand({
      SecretId: secretId,
      ForceDeleteWithoutRecovery: forceDeleteWithoutRecovery || undefined,
      RecoveryWindowInDays: forceDeleteWithoutRecovery ? undefined : 7
    })
  )
}

export async function restoreSecret(connection: AwsConnection, secretId: string): Promise<void> {
  const client = getAwsClient(SecretsManagerClient, connection)
  await client.send(new RestoreSecretCommand({ SecretId: secretId }))
}

export async function updateSecretValue(connection: AwsConnection, secretId: string, secretString: string): Promise<void> {
  const client = getAwsClient(SecretsManagerClient, connection)
  await client.send(new UpdateSecretCommand({ SecretId: secretId, SecretString: secretString }))
}

export async function updateSecretDescription(connection: AwsConnection, secretId: string, description: string): Promise<void> {
  const client = getAwsClient(SecretsManagerClient, connection)
  await client.send(new UpdateSecretCommand({ SecretId: secretId, Description: description }))
}

export async function rotateSecret(connection: AwsConnection, secretId: string): Promise<void> {
  const client = getAwsClient(SecretsManagerClient, connection)
  await client.send(new RotateSecretCommand({ SecretId: secretId, RotateImmediately: true }))
}

export async function putSecretResourcePolicy(connection: AwsConnection, secretId: string, policy: string): Promise<void> {
  const client = getAwsClient(SecretsManagerClient, connection)
  await client.send(new PutResourcePolicyCommand({ SecretId: secretId, ResourcePolicy: policy }))
}

export async function tagSecret(connection: AwsConnection, secretId: string, tags: SecretTag[]): Promise<void> {
  const client = getAwsClient(SecretsManagerClient, connection)
  await client.send(new TagResourceCommand({ SecretId: secretId, Tags: normalizeTags(tags) }))
}

export async function untagSecret(connection: AwsConnection, secretId: string, tagKeys: string[]): Promise<void> {
  const client = getAwsClient(SecretsManagerClient, connection)
  await client.send(new UntagResourceCommand({ SecretId: secretId, TagKeys: tagKeys }))
}
