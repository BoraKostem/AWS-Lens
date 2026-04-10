import type { BucketLocationConstraint } from '@aws-sdk/client-s3'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  type GetBucketEncryptionCommandOutput,
  GetBucketLifecycleConfigurationCommand,
  type GetBucketLifecycleConfigurationCommandOutput,
  GetBucketLocationCommand,
  GetBucketLoggingCommand,
  type GetBucketLoggingCommandOutput,
  GetBucketPolicyCommand,
  type GetBucketPolicyCommandOutput,
  GetPublicAccessBlockCommand,
  type GetPublicAccessBlockCommandOutput,
  GetBucketReplicationCommand,
  type GetBucketReplicationCommandOutput,
  GetBucketTaggingCommand,
  type GetBucketTaggingCommandOutput,
  GetBucketVersioningCommand,
  type GetBucketVersioningCommandOutput,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { createWriteStream, watchFile, unwatchFile } from 'fs'
import { chmod, readFile, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

import type {
  AwsConnection,
  S3BucketGovernanceCheck,
  S3BucketGovernanceDetail,
  S3BucketGovernanceFinding,
  S3BucketGovernancePosture,
  S3BucketSummary,
  S3GovernanceOverview,
  S3GovernanceSeverity,
  S3ObjectContent,
  S3ObjectSummary
} from '@shared/types'
import { getAwsClient } from './client'

function normalizeBucketRegion(region: string | null | undefined, fallback: string): string {
  if (!region) {
    return 'us-east-1'
  }
  if (region === 'EU') {
    return 'eu-west-1'
  }
  return region || fallback
}

function toBucketConnection(connection: AwsConnection, region: string): AwsConnection {
  return {
    ...connection,
    region
  }
}

function isAwsError(error: unknown, ...codes: string[]): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const candidate = error as { name?: string; Code?: string; code?: string }
  return codes.includes(candidate.name ?? '') || codes.includes(candidate.Code ?? '') || codes.includes(candidate.code ?? '')
}

function formatUnknownSummary(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return `${fallback}: ${error.message}`
  }
  return fallback
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function emptyCheck(status: S3BucketGovernanceCheck['status'], summary: string): S3BucketGovernanceCheck {
  return { status, summary }
}

function severityRank(severity: S3GovernanceSeverity): number {
  switch (severity) {
    case 'critical': return 5
    case 'high': return 4
    case 'medium': return 3
    case 'low': return 2
    case 'info': return 1
  }
}

function compareSeverity(left: S3GovernanceSeverity, right: S3GovernanceSeverity): number {
  return severityRank(left) - severityRank(right)
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  mapper: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results = new Array<TOutput>(items.length)
  let index = 0

  async function worker(): Promise<void> {
    while (true) {
      const current = index
      index += 1
      if (current >= items.length) {
        return
      }
      results[current] = await mapper(items[current])
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

async function resolveBucketRegion(connection: AwsConnection, bucketName: string): Promise<string> {
  const client = getAwsClient(S3Client, connection)
  const location = await client.send(new GetBucketLocationCommand({ Bucket: bucketName }))
  return normalizeBucketRegion(location.LocationConstraint, connection.region)
}

function sanitizeJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function deriveImportantBucket(bucketName: string, tags: Record<string, string>): { important: boolean; reason: string } {
  const normalizedName = bucketName.toLowerCase()
  const importantNameHints = ['prod', 'production', 'critical', 'backup', 'state', 'audit', 'logs', 'log', 'artifact']
  const matchedNameHint = importantNameHints.find((hint) => normalizedName.includes(hint))

  if (matchedNameHint) {
    return {
      important: true,
      reason: `Name suggests critical usage (${matchedNameHint}).`
    }
  }

  for (const [key, rawValue] of Object.entries(tags)) {
    const tagKey = key.toLowerCase()
    const tagValue = rawValue.toLowerCase()
    if (
      tagKey.includes('environment') ||
      tagKey.includes('tier') ||
      tagKey.includes('critical') ||
      tagKey.includes('compliance') ||
      tagKey.includes('backup')
    ) {
      if (['prod', 'production', 'critical', 'true', 'yes', 'regulated'].includes(tagValue)) {
        return {
          important: true,
          reason: `Tag ${key}=${rawValue} indicates elevated importance.`
        }
      }
    }
  }

  return {
    important: false,
    reason: ''
  }
}

function buildGovernanceFindings(posture: Omit<S3BucketGovernancePosture, 'highestSeverity' | 'findings'>): S3BucketGovernanceFinding[] {
  const findings: S3BucketGovernanceFinding[] = []

  if (posture.publicAccessBlock.status !== 'enabled') {
    findings.push({
      id: 'public-access-block',
      severity: posture.publicAccessBlock.status === 'unknown' ? 'medium' : 'critical',
      title: posture.publicAccessBlock.status === 'unknown'
        ? 'Public access posture could not be verified'
        : 'Public access block is not fully enabled',
      summary: posture.publicAccessBlock.summary,
      nextStep: posture.publicAccessBlock.status === 'unknown'
        ? 'Verify `s3:GetBucketPublicAccessBlock` permissions and confirm the bucket is fully blocked.'
        : 'Enable all four public access block settings unless the bucket is intentionally public.'
    })
  }

  if (posture.encryption.status !== 'enabled') {
    findings.push({
      id: 'default-encryption',
      severity: posture.encryption.status === 'unknown' ? 'medium' : 'high',
      title: posture.encryption.status === 'unknown'
        ? 'Default encryption could not be verified'
        : 'Bucket default encryption is not enabled',
      summary: posture.encryption.summary,
      nextStep: posture.encryption.status === 'unknown'
        ? 'Verify `s3:GetEncryptionConfiguration` permissions.'
        : 'Enable default encryption for new objects.'
    })
  }

  if (posture.important && posture.versioning.status !== 'enabled') {
    findings.push({
      id: 'important-no-versioning',
      severity: posture.versioning.status === 'unknown' ? 'medium' : 'high',
      title: 'Important bucket is not versioned',
      summary: posture.versioning.summary || posture.importantReason,
      nextStep: 'Enable bucket versioning before accidental overwrite or deletion becomes an issue.'
    })
  } else if (!posture.important && posture.versioning.status === 'disabled') {
    findings.push({
      id: 'versioning-disabled',
      severity: 'low',
      title: 'Bucket versioning is disabled',
      summary: posture.versioning.summary,
      nextStep: 'Enable versioning if the bucket stores mutable or operationally important content.'
    })
  }

  if (posture.lifecycle.status === 'missing') {
    findings.push({
      id: 'lifecycle-missing',
      severity: posture.important ? 'medium' : 'low',
      title: 'Lifecycle rules are missing',
      summary: posture.lifecycle.summary,
      nextStep: 'Add lifecycle rules for retention, archive, or aborting incomplete multipart uploads.'
    })
  } else if (posture.lifecycle.status === 'unknown') {
    findings.push({
      id: 'lifecycle-unknown',
      severity: 'low',
      title: 'Lifecycle configuration could not be verified',
      summary: posture.lifecycle.summary,
      nextStep: 'Verify `s3:GetLifecycleConfiguration` permissions.'
    })
  }

  if (posture.logging.status === 'disabled') {
    findings.push({
      id: 'access-logging-disabled',
      severity: posture.important ? 'medium' : 'low',
      title: 'Server access logging is disabled',
      summary: posture.logging.summary,
      nextStep: 'Enable access logging if you need bucket-level request auditing.'
    })
  }

  if (posture.replication.status === 'disabled' && posture.important) {
    findings.push({
      id: 'replication-disabled',
      severity: 'low',
      title: 'Important bucket does not have replication',
      summary: posture.replication.summary,
      nextStep: 'Consider replication if cross-region resilience or account isolation is required.'
    })
  }

  if (posture.policy.status === 'unknown') {
    findings.push({
      id: 'policy-unknown',
      severity: 'low',
      title: 'Bucket policy could not be verified',
      summary: posture.policy.summary,
      nextStep: 'Verify `s3:GetBucketPolicy` permissions if policy review is required.'
    })
  }

  return findings.sort((left, right) => compareSeverity(right.severity, left.severity))
}

async function inspectBucketGovernance(
  connection: AwsConnection,
  bucket: S3BucketSummary
): Promise<S3BucketGovernanceDetail> {
  const bucketConnection = toBucketConnection(connection, bucket.region || connection.region)
  const client = getAwsClient(S3Client, bucketConnection)

  const [
    publicAccessBlockResult,
    encryptionResult,
    versioningResult,
    lifecycleResult,
    policyResult,
    loggingResult,
    replicationResult,
    taggingResult
  ]: [
    GetPublicAccessBlockCommandOutput | Error,
    GetBucketEncryptionCommandOutput | Error,
    GetBucketVersioningCommandOutput | Error,
    GetBucketLifecycleConfigurationCommandOutput | Error,
    GetBucketPolicyCommandOutput | Error,
    GetBucketLoggingCommandOutput | Error,
    GetBucketReplicationCommandOutput | Error,
    GetBucketTaggingCommandOutput | Error
  ] = await Promise.all([
    client.send(new GetPublicAccessBlockCommand({ Bucket: bucket.name })).catch((error: unknown) => toError(error)),
    client.send(new GetBucketEncryptionCommand({ Bucket: bucket.name })).catch((error: unknown) => toError(error)),
    client.send(new GetBucketVersioningCommand({ Bucket: bucket.name })).catch((error: unknown) => toError(error)),
    client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket.name })).catch((error: unknown) => toError(error)),
    client.send(new GetBucketPolicyCommand({ Bucket: bucket.name })).catch((error: unknown) => toError(error)),
    client.send(new GetBucketLoggingCommand({ Bucket: bucket.name })).catch((error: unknown) => toError(error)),
    client.send(new GetBucketReplicationCommand({ Bucket: bucket.name })).catch((error: unknown) => toError(error)),
    client.send(new GetBucketTaggingCommand({ Bucket: bucket.name })).catch((error: unknown) => toError(error))
  ])

  const publicAccessBlock = (() => {
    if (!(publicAccessBlockResult instanceof Error)) {
      const config = publicAccessBlockResult.PublicAccessBlockConfiguration
      const checks = [
        Boolean(config?.BlockPublicAcls),
        Boolean(config?.IgnorePublicAcls),
        Boolean(config?.BlockPublicPolicy),
        Boolean(config?.RestrictPublicBuckets)
      ]
      const enabledCount = checks.filter(Boolean).length
      return {
        status: enabledCount === 4 ? 'enabled' : enabledCount === 0 ? 'disabled' : 'partial',
        summary: enabledCount === 4
          ? 'All public access block settings are enabled.'
          : enabledCount === 0
            ? 'No public access block settings are enabled.'
            : `${enabledCount} of 4 public access block settings are enabled.`,
        blockPublicAcls: config?.BlockPublicAcls ?? null,
        ignorePublicAcls: config?.IgnorePublicAcls ?? null,
        blockPublicPolicy: config?.BlockPublicPolicy ?? null,
        restrictPublicBuckets: config?.RestrictPublicBuckets ?? null
      } satisfies S3BucketGovernancePosture['publicAccessBlock']
    }

    return {
      status: isAwsError(publicAccessBlockResult, 'NoSuchPublicAccessBlockConfiguration') ? 'disabled' : 'unknown',
      summary: isAwsError(publicAccessBlockResult, 'NoSuchPublicAccessBlockConfiguration')
        ? 'No bucket-level public access block configuration is set.'
        : formatUnknownSummary(publicAccessBlockResult, 'Public access block could not be verified'),
      blockPublicAcls: null,
      ignorePublicAcls: null,
      blockPublicPolicy: null,
      restrictPublicBuckets: null
    } satisfies S3BucketGovernancePosture['publicAccessBlock']
  })()

  const encryption = (() => {
    if (!(encryptionResult instanceof Error)) {
      const rules = encryptionResult.ServerSideEncryptionConfiguration?.Rules ?? []
      const algorithm = rules[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm ?? ''
      const kmsKeyId = rules[0]?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID ?? ''
      return {
        status: rules.length > 0 ? 'enabled' : 'disabled',
        summary: rules.length > 0
          ? `Default encryption is enabled (${algorithm || 'configured'}).`
          : 'No default encryption rule is configured.',
        algorithm,
        kmsKeyId
      } satisfies S3BucketGovernancePosture['encryption']
    }

    return {
      status: isAwsError(encryptionResult, 'ServerSideEncryptionConfigurationNotFoundError', 'NoSuchServerSideEncryptionConfiguration')
        ? 'disabled'
        : 'unknown',
      summary: isAwsError(encryptionResult, 'ServerSideEncryptionConfigurationNotFoundError', 'NoSuchServerSideEncryptionConfiguration')
        ? 'Bucket default encryption is not configured.'
        : formatUnknownSummary(encryptionResult, 'Encryption configuration could not be verified'),
      algorithm: '',
      kmsKeyId: ''
    } satisfies S3BucketGovernancePosture['encryption']
  })()

  const versioning = (() => {
    if (!(versioningResult instanceof Error)) {
      const status = versioningResult.Status ?? ''
      const mfaDelete = versioningResult.MFADelete === 'Enabled'
      if (status === 'Enabled') {
        return {
          status: 'enabled',
          summary: 'Bucket versioning is enabled.',
          mfaDelete
        } satisfies S3BucketGovernancePosture['versioning']
      }
      if (status === 'Suspended') {
        return {
          status: 'suspended',
          summary: 'Bucket versioning is suspended.',
          mfaDelete
        } satisfies S3BucketGovernancePosture['versioning']
      }
      return {
        status: 'disabled',
        summary: 'Bucket versioning is not enabled.',
        mfaDelete
      } satisfies S3BucketGovernancePosture['versioning']
    }

    return {
      status: 'unknown',
      summary: formatUnknownSummary(versioningResult, 'Versioning could not be verified'),
      mfaDelete: null
    } satisfies S3BucketGovernancePosture['versioning']
  })()

  const lifecycle = (() => {
    if (!(lifecycleResult instanceof Error)) {
      const rules = lifecycleResult.Rules ?? []
      return {
        status: rules.length > 0 ? 'present' : 'missing',
        summary: rules.length > 0
          ? `${rules.length} lifecycle rule${rules.length === 1 ? '' : 's'} configured.`
          : 'No lifecycle rules configured.',
        ruleCount: rules.length
      } satisfies S3BucketGovernancePosture['lifecycle']
    }

    return {
      status: isAwsError(lifecycleResult, 'NoSuchLifecycleConfiguration') ? 'missing' : 'unknown',
      summary: isAwsError(lifecycleResult, 'NoSuchLifecycleConfiguration')
        ? 'No lifecycle rules configured.'
        : formatUnknownSummary(lifecycleResult, 'Lifecycle configuration could not be verified'),
      ruleCount: 0
    } satisfies S3BucketGovernancePosture['lifecycle']
  })()

  const policy = (() => {
    if (!(policyResult instanceof Error)) {
      const policyText = policyResult.Policy ?? ''
      try {
        const parsed = policyText ? JSON.parse(policyText) : null
        const statements = Array.isArray(parsed?.Statement) ? parsed.Statement.length : parsed?.Statement ? 1 : 0
        return {
          status: policyText ? 'present' : 'missing',
          summary: policyText
            ? `${statements} policy statement${statements === 1 ? '' : 's'} configured.`
            : 'No bucket policy configured.',
          statementCount: statements
        } satisfies S3BucketGovernancePosture['policy']
      } catch {
        return {
          status: 'present',
          summary: 'Bucket policy is present.',
          statementCount: 0
        } satisfies S3BucketGovernancePosture['policy']
      }
    }

    return {
      status: isAwsError(policyResult, 'NoSuchBucketPolicy') ? 'missing' : 'unknown',
      summary: isAwsError(policyResult, 'NoSuchBucketPolicy')
        ? 'No bucket policy configured.'
        : formatUnknownSummary(policyResult, 'Bucket policy could not be verified'),
      statementCount: 0
    } satisfies S3BucketGovernancePosture['policy']
  })()

  const logging = (() => {
    if (!(loggingResult instanceof Error)) {
      const targetBucket = loggingResult.LoggingEnabled?.TargetBucket ?? ''
      const targetPrefix = loggingResult.LoggingEnabled?.TargetPrefix ?? ''
      return {
        status: targetBucket ? 'enabled' : 'disabled',
        summary: targetBucket
          ? `Server access logging writes to ${targetBucket}${targetPrefix ? `/${targetPrefix}` : ''}.`
          : 'Server access logging is disabled.',
        targetBucket,
        targetPrefix
      } satisfies S3BucketGovernancePosture['logging']
    }

    return {
      status: 'unknown',
      summary: formatUnknownSummary(loggingResult, 'Logging configuration could not be verified'),
      targetBucket: '',
      targetPrefix: ''
    } satisfies S3BucketGovernancePosture['logging']
  })()

  const replication = (() => {
    if (!(replicationResult instanceof Error)) {
      const rules = replicationResult.ReplicationConfiguration?.Rules ?? []
      const destinationBuckets = rules
        .map((rule) => rule.Destination?.Bucket ?? '')
        .filter((value): value is string => Boolean(value))
      return {
        status: rules.length > 0 ? 'enabled' : 'disabled',
        summary: rules.length > 0
          ? `${rules.length} replication rule${rules.length === 1 ? '' : 's'} configured.`
          : 'Replication is not configured.',
        ruleCount: rules.length,
        destinationBuckets
      } satisfies S3BucketGovernancePosture['replication']
    }

    return {
      status: isAwsError(replicationResult, 'ReplicationConfigurationNotFoundError') ? 'disabled' : 'unknown',
      summary: isAwsError(replicationResult, 'ReplicationConfigurationNotFoundError')
        ? 'Replication is not configured.'
        : formatUnknownSummary(replicationResult, 'Replication configuration could not be verified'),
      ruleCount: 0,
      destinationBuckets: []
    } satisfies S3BucketGovernancePosture['replication']
  })()

  const tags = (() => {
    if (!(taggingResult instanceof Error)) {
      return Object.fromEntries((taggingResult.TagSet ?? []).map((tag) => [tag.Key ?? '', tag.Value ?? '']).filter(([key]) => key))
    }
    return {} as Record<string, string>
  })()

  const importance = deriveImportantBucket(bucket.name, tags)

  const postureBase = {
    bucketName: bucket.name,
    region: bucket.region,
    publicAccessBlock,
    encryption,
    versioning,
    lifecycle,
    policy,
    logging,
    replication,
    important: importance.important,
    importantReason: importance.reason
  }

  const findings = buildGovernanceFindings(postureBase)
  const highestSeverity = findings[0]?.severity ?? 'info'
  let policyJson = ''
  if (!(policyResult instanceof Error) && policyResult.Policy) {
    try {
      policyJson = sanitizeJson(JSON.parse(policyResult.Policy))
    } catch {
      policyJson = policyResult.Policy
    }
  }
  const lifecycleJson = !(lifecycleResult instanceof Error) && lifecycleResult.Rules
    ? sanitizeJson({ Rules: lifecycleResult.Rules })
    : ''

  return {
    posture: {
      ...postureBase,
      highestSeverity,
      findings
    },
    policyJson,
    lifecycleJson
  }
}

/* Buckets */

export async function listBuckets(connection: AwsConnection): Promise<S3BucketSummary[]> {
  const client = getAwsClient(S3Client, connection)
  const output = await client.send(new ListBucketsCommand({}))

  const buckets = await Promise.all((output.Buckets ?? []).map(async (bucket) => {
    const name = bucket.Name ?? '-'
    let region = connection.region
    let tags: Record<string, string> = {}

    if (name !== '-') {
      try {
        region = await resolveBucketRegion(connection, name)
      } catch {
        region = connection.region
      }

      try {
        const tagOutput = await client.send(new GetBucketTaggingCommand({ Bucket: name }))
        tags = Object.fromEntries((tagOutput.TagSet ?? []).flatMap((tag) => tag.Key ? [[tag.Key, tag.Value ?? '']] : []))
      } catch {
        tags = {}
      }
    }

    return {
      name,
      creationDate: bucket.CreationDate?.toISOString() ?? '-',
      region,
      tags
    }
  }))

  return buckets.sort((left, right) => left.name.localeCompare(right.name))
}

export async function createBucket(connection: AwsConnection, bucketName: string): Promise<void> {
  const client = getAwsClient(S3Client, connection)
  await client.send(new CreateBucketCommand({
    Bucket: bucketName,
    ...(connection.region !== 'us-east-1' && {
      CreateBucketConfiguration: {
        LocationConstraint: connection.region as BucketLocationConstraint
      }
    })
  }))
}

export async function listBucketGovernance(connection: AwsConnection): Promise<S3GovernanceOverview> {
  const buckets = await listBuckets(connection)
  const details = await mapWithConcurrency(buckets, 4, async (bucket) => inspectBucketGovernance(connection, bucket))
  const postures = details.map((detail) => detail.posture)

  const summary = {
    bucketCount: postures.length,
    riskyBucketCount: postures.filter((bucket) => bucket.highestSeverity === 'critical' || bucket.highestSeverity === 'high').length,
    publicAccessRiskCount: postures.filter((bucket) => bucket.publicAccessBlock.status !== 'enabled').length,
    unencryptedBucketCount: postures.filter((bucket) => bucket.encryption.status !== 'enabled').length,
    missingLifecycleCount: postures.filter((bucket) => bucket.lifecycle.status === 'missing').length,
    importantWithoutVersioningCount: postures.filter((bucket) => bucket.important && bucket.versioning.status !== 'enabled').length,
    bucketsBySeverity: {
      critical: postures.filter((bucket) => bucket.highestSeverity === 'critical').length,
      high: postures.filter((bucket) => bucket.highestSeverity === 'high').length,
      medium: postures.filter((bucket) => bucket.highestSeverity === 'medium').length,
      low: postures.filter((bucket) => bucket.highestSeverity === 'low').length,
      info: postures.filter((bucket) => bucket.highestSeverity === 'info').length
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    summary,
    buckets: postures.sort((left, right) => {
      const severityDiff = compareSeverity(right.highestSeverity, left.highestSeverity)
      if (severityDiff !== 0) {
        return severityDiff
      }
      return left.bucketName.localeCompare(right.bucketName)
    })
  }
}

export async function getBucketGovernanceDetail(
  connection: AwsConnection,
  bucketName: string
): Promise<S3BucketGovernanceDetail> {
  const region = await resolveBucketRegion(connection, bucketName)
  return inspectBucketGovernance(connection, {
    name: bucketName,
    creationDate: '-',
    region
  })
}

export async function enableBucketVersioning(connection: AwsConnection, bucketName: string): Promise<void> {
  const region = await resolveBucketRegion(connection, bucketName)
  const client = getAwsClient(S3Client, toBucketConnection(connection, region))
  await client.send(new PutBucketVersioningCommand({
    Bucket: bucketName,
    VersioningConfiguration: {
      Status: 'Enabled'
    }
  }))
}

export async function enableBucketEncryption(connection: AwsConnection, bucketName: string): Promise<void> {
  const region = await resolveBucketRegion(connection, bucketName)
  const client = getAwsClient(S3Client, toBucketConnection(connection, region))
  await client.send(new PutBucketEncryptionCommand({
    Bucket: bucketName,
    ServerSideEncryptionConfiguration: {
      Rules: [{
        ApplyServerSideEncryptionByDefault: {
          SSEAlgorithm: 'AES256'
        },
        BucketKeyEnabled: true
      }]
    }
  }))
}

export async function putBucketPolicy(connection: AwsConnection, bucketName: string, policyJson: string): Promise<void> {
  const region = await resolveBucketRegion(connection, bucketName)
  const client = getAwsClient(S3Client, toBucketConnection(connection, region))
  const normalizedPolicy = sanitizeJson(JSON.parse(policyJson))
  await client.send(new PutBucketPolicyCommand({
    Bucket: bucketName,
    Policy: normalizedPolicy
  }))
}

/* Objects */

export async function listBucketObjects(
  connection: AwsConnection,
  bucketName: string,
  prefix = ''
): Promise<S3ObjectSummary[]> {
  const client = getAwsClient(S3Client, connection)
  const objects: S3ObjectSummary[] = []
  let continuationToken: string | undefined

  const folderSet = new Set<string>()

  do {
    const output = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      Delimiter: '/',
      ContinuationToken: continuationToken,
      MaxKeys: 500
    }))

    for (const cp of output.CommonPrefixes ?? []) {
      const value = cp.Prefix ?? ''
      if (value && !folderSet.has(value)) {
        folderSet.add(value)
        objects.push({
          key: value,
          size: 0,
          lastModified: '-',
          storageClass: '-',
          isFolder: true
        })
      }
    }

    for (const item of output.Contents ?? []) {
      const key = item.Key ?? ''
      if (key === prefix) continue
      objects.push({
        key,
        size: Number(item.Size ?? 0),
        lastModified: item.LastModified?.toISOString() ?? '-',
        storageClass: item.StorageClass ?? '-',
        isFolder: false
      })
    }

    continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined
  } while (continuationToken)

  const folders = objects.filter((object) => object.isFolder).sort((left, right) => left.key.localeCompare(right.key))
  const files = objects.filter((object) => !object.isFolder).sort((left, right) => left.key.localeCompare(right.key))
  return [...folders, ...files]
}

export async function deleteObject(connection: AwsConnection, bucketName: string, key: string): Promise<void> {
  const client = getAwsClient(S3Client, connection)
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
}

export async function getPresignedUrl(
  connection: AwsConnection,
  bucketName: string,
  key: string,
  expiresIn = 3600
): Promise<string> {
  const client = getAwsClient(S3Client, connection)
  const command = new GetObjectCommand({ Bucket: bucketName, Key: key })
  return getSignedUrl(client, command, { expiresIn })
}

export async function createFolder(connection: AwsConnection, bucketName: string, folderKey: string): Promise<void> {
  const client = getAwsClient(S3Client, connection)
  const key = folderKey.endsWith('/') ? folderKey : `${folderKey}/`
  await client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: '' }))
}

/* Download */

export async function downloadObject(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<string> {
  const client = getAwsClient(S3Client, connection)
  const output = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))

  const fileName = basename(key.split('/').pop() || 'download').replace(/\.\./g, '_')
  const tempDir = app.getPath('temp')
  const filePath = join(tempDir, `s3-${Date.now()}-${fileName}`)

  if (output.Body instanceof Readable) {
    const ws = createWriteStream(filePath, { mode: 0o600 })
    await pipeline(output.Body, ws)
  } else if (output.Body) {
    const bytes = await output.Body.transformToByteArray()
    await writeFile(filePath, Buffer.from(bytes), { mode: 0o600 })
  }

  return filePath
}

export async function downloadObjectToPath(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<string> {
  const fileName = basename(key.split('/').pop() || 'download').replace(/\.\./g, '_')
  const win = BrowserWindow.getFocusedWindow()
  const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
    defaultPath: fileName,
    title: 'Save S3 Object'
  })

  if (result.canceled || !result.filePath) return ''

  const client = getAwsClient(S3Client, connection)
  const output = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))

  if (output.Body instanceof Readable) {
    const ws = createWriteStream(result.filePath)
    await pipeline(output.Body, ws)
  } else if (output.Body) {
    const bytes = await output.Body.transformToByteArray()
    await writeFile(result.filePath, Buffer.from(bytes))
  }

  return result.filePath
}

export async function openDownloadedObject(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<string> {
  const filePath = await downloadObject(connection, bucketName, key)
  void shell.openPath(filePath)
  return filePath
}

const watchedFiles = new Set<string>()

export async function openInVSCode(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<string> {
  const filePath = await downloadObject(connection, bucketName, key)
  void shell.openExternal(`vscode://file/${encodeURI(filePath)}`)

  if (watchedFiles.has(filePath)) {
    unwatchFile(filePath)
  }

  let uploading = false
  watchFile(filePath, { interval: 1000 }, async (curr, prev) => {
    if (curr.mtimeMs === prev.mtimeMs || uploading) {
      return
    }
    uploading = true
    try {
      await uploadObject(connection, bucketName, key, filePath)
    } catch {
      unwatchFile(filePath)
      watchedFiles.delete(filePath)
    } finally {
      uploading = false
    }
  })

  watchedFiles.add(filePath)

  app.once('before-quit', () => {
    unwatchFile(filePath)
    watchedFiles.delete(filePath)
  })

  return filePath
}

/* Get / Put text content */

export async function getObjectContent(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<S3ObjectContent> {
  const client = getAwsClient(S3Client, connection)
  const output = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))
  const contentType = output.ContentType ?? 'application/octet-stream'

  let body = ''
  if (output.Body) {
    const bytes = await output.Body.transformToByteArray()
    body = Buffer.from(bytes).toString('utf-8')
  }

  return { body, contentType }
}

export async function putObjectContent(
  connection: AwsConnection,
  bucketName: string,
  key: string,
  content: string,
  contentType?: string
): Promise<void> {
  const client = getAwsClient(S3Client, connection)
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: content,
    ContentType: contentType ?? 'text/plain'
  }))
}

/* Upload from local file */

export async function uploadObject(
  connection: AwsConnection,
  bucketName: string,
  key: string,
  localPath: string
): Promise<void> {
  const client = getAwsClient(S3Client, connection)
  const fileBuffer = await readFile(localPath)
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileBuffer
  }))
}
