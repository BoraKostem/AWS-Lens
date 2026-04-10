import {
  type Capability,
  CloudFormationClient,
  CreateChangeSetCommand,
  DeleteChangeSetCommand,
  DescribeChangeSetCommand,
  DescribeStackDriftDetectionStatusCommand,
  DescribeStackResourceDriftsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  DetectStackDriftCommand,
  ExecuteChangeSetCommand,
  ListChangeSetsCommand,
  ListStacksCommand
} from '@aws-sdk/client-cloudformation'

import type {
  AwsConnection,
  CloudFormationChangeSetDetail,
  CloudFormationChangeSetSummary,
  CloudFormationDriftedResourceRow,
  CloudFormationResourceSummary,
  CloudFormationStackDriftSummary,
  CloudFormationStackSummary
} from '@shared/types'
import { getAwsClient } from './client'

export async function listStacks(connection: AwsConnection): Promise<CloudFormationStackSummary[]> {
  const client = getAwsClient(CloudFormationClient, connection)
  const stacks: CloudFormationStackSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListStacksCommand({
      NextToken: nextToken,
      StackStatusFilter: [
        'CREATE_COMPLETE',
        'CREATE_FAILED',
        'ROLLBACK_COMPLETE',
        'ROLLBACK_FAILED',
        'UPDATE_COMPLETE',
        'UPDATE_ROLLBACK_COMPLETE',
        'UPDATE_IN_PROGRESS',
        'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS'
      ]
    }))

    for (const item of output.StackSummaries ?? []) {
      stacks.push({
        stackName: item.StackName ?? '-',
        stackId: item.StackId ?? '-',
        status: item.StackStatus ?? '-',
        description: '',
        creationTime: item.CreationTime?.toISOString() ?? '-',
        lastUpdatedTime: item.LastUpdatedTime?.toISOString() ?? '-'
      })
    }

    nextToken = output.NextToken
  } while (nextToken)

  return stacks.sort((left, right) => left.stackName.localeCompare(right.stackName))
}

export async function listStackResources(
  connection: AwsConnection,
  stackName: string
): Promise<CloudFormationResourceSummary[]> {
  const client = getAwsClient(CloudFormationClient, connection)
  const output = await client.send(new DescribeStackResourcesCommand({ StackName: stackName }))

  return (output.StackResources ?? []).map((item) => ({
    logicalResourceId: item.LogicalResourceId ?? '-',
    physicalResourceId: item.PhysicalResourceId ?? '-',
    resourceType: item.ResourceType ?? '-',
    resourceStatus: item.ResourceStatus ?? '-',
    timestamp: item.Timestamp?.toISOString() ?? '-'
  }))
}

function mapChangeSetSummary(
  item: {
    StackName?: string
    StackId?: string
    ChangeSetName?: string
    ChangeSetId?: string
    Description?: string
    Status?: string
    ExecutionStatus?: string
    StatusReason?: string
    ChangeSetType?: string
    CreationTime?: Date
  },
  stackName: string
): CloudFormationChangeSetSummary {
  return {
    stackName: item.StackName ?? stackName,
    stackId: item.StackId ?? '-',
    changeSetName: item.ChangeSetName ?? '-',
    changeSetId: item.ChangeSetId ?? '-',
    description: item.Description ?? '',
    status: item.Status ?? '-',
    executionStatus: item.ExecutionStatus ?? '-',
    statusReason: item.StatusReason ?? '',
    changeSetType: item.ChangeSetType ?? '-',
    creationTime: item.CreationTime?.toISOString() ?? '-'
  }
}

export async function listChangeSets(
  connection: AwsConnection,
  stackName: string
): Promise<CloudFormationChangeSetSummary[]> {
  const client = getAwsClient(CloudFormationClient, connection)
  const summaries: CloudFormationChangeSetSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListChangeSetsCommand({
      StackName: stackName,
      NextToken: nextToken
    }))

    for (const item of output.Summaries ?? []) {
      summaries.push(mapChangeSetSummary(item, stackName))
    }

    nextToken = output.NextToken
  } while (nextToken)

  return summaries.sort((left, right) => right.creationTime.localeCompare(left.creationTime))
}

export async function getChangeSetDetail(
  connection: AwsConnection,
  stackName: string,
  changeSetName: string
): Promise<CloudFormationChangeSetDetail> {
  const client = getAwsClient(CloudFormationClient, connection)
  const output = await client.send(new DescribeChangeSetCommand({
    StackName: stackName,
    ChangeSetName: changeSetName
  }))

  return {
    summary: mapChangeSetSummary(output, stackName),
    parameters: (output.Parameters ?? []).map((parameter) => ({
      parameterKey: parameter.ParameterKey ?? '-',
      parameterValue: parameter.ParameterValue ?? '',
      usePreviousValue: parameter.UsePreviousValue ?? false
    })),
    capabilities: output.Capabilities ?? [],
    changes: (output.Changes ?? []).map((change) => {
      const resourceChange = change.ResourceChange
      return {
        action: resourceChange?.Action ?? '-',
        logicalResourceId: resourceChange?.LogicalResourceId ?? '-',
        physicalResourceId: resourceChange?.PhysicalResourceId ?? '-',
        resourceType: resourceChange?.ResourceType ?? '-',
        replacement: resourceChange?.Replacement ?? '-',
        scope: resourceChange?.Scope ?? [],
        details: (resourceChange?.Details ?? []).map((detail) => {
          const target = detail.Target
          const attributeParts = [
            target?.Attribute,
            target?.Name,
            target?.RequiresRecreation
          ].filter(Boolean)

          return [
            target?.Path,
            attributeParts.length ? `(${attributeParts.join(', ')})` : '',
            detail.Evaluation ? `via ${detail.Evaluation}` : '',
            detail.CausingEntity ? `from ${detail.CausingEntity}` : ''
          ].filter(Boolean).join(' ')
        })
      }
    }),
    rawJson: JSON.stringify(output, null, 2)
  }
}

export async function createChangeSet(
  connection: AwsConnection,
  input: {
    stackName: string
    changeSetName: string
    description?: string
    templateBody?: string
    templateUrl?: string
    usePreviousTemplate?: boolean
    capabilities?: string[]
    parameters?: Array<{
      parameterKey: string
      parameterValue?: string
      usePreviousValue?: boolean
    }>
  }
): Promise<CloudFormationChangeSetSummary> {
  const client = getAwsClient(CloudFormationClient, connection)
  const output = await client.send(new CreateChangeSetCommand({
    StackName: input.stackName,
    ChangeSetName: input.changeSetName,
    Description: input.description,
    ChangeSetType: 'UPDATE',
    UsePreviousTemplate: input.usePreviousTemplate ?? false,
    TemplateBody: input.templateBody,
    TemplateURL: input.templateUrl,
    Capabilities: input.capabilities as Capability[] | undefined,
    Parameters: input.parameters?.map((parameter) => ({
      ParameterKey: parameter.parameterKey,
      ParameterValue: parameter.parameterValue,
      UsePreviousValue: parameter.usePreviousValue
    }))
  }))

  return mapChangeSetSummary({
    StackName: input.stackName,
    StackId: '',
    ChangeSetName: input.changeSetName,
    ChangeSetId: output.Id,
    Description: input.description,
    Status: 'CREATE_PENDING',
    ExecutionStatus: 'UNAVAILABLE',
    StatusReason: '',
    ChangeSetType: 'UPDATE',
    CreationTime: new Date()
  }, input.stackName)
}

export async function executeChangeSet(
  connection: AwsConnection,
  stackName: string,
  changeSetName: string
): Promise<void> {
  const client = getAwsClient(CloudFormationClient, connection)
  await client.send(new ExecuteChangeSetCommand({
    StackName: stackName,
    ChangeSetName: changeSetName
  }))
}

export async function deleteChangeSet(
  connection: AwsConnection,
  stackName: string,
  changeSetName: string
): Promise<void> {
  const client = getAwsClient(CloudFormationClient, connection)
  await client.send(new DeleteChangeSetCommand({
    StackName: stackName,
    ChangeSetName: changeSetName
  }))
}

function mapStackDriftSummary(
  item: {
    StackName?: string
    StackId?: string
    StackDriftStatus?: string
    StackDriftDetectionId?: string
    DetectionStatus?: string
    DetectionStatusReason?: string
    LastCheckTimestamp?: Date
  },
  stackName: string
): CloudFormationStackDriftSummary {
  return {
    stackName: item.StackName ?? stackName,
    stackId: item.StackId ?? '-',
    stackDriftStatus: item.StackDriftStatus ?? 'NOT_CHECKED',
    detectionStatus: item.DetectionStatus ?? 'NOT_STARTED',
    detectionStatusReason: item.DetectionStatusReason ?? '',
    driftDetectionId: item.StackDriftDetectionId ?? '',
    lastCheckTimestamp: item.LastCheckTimestamp?.toISOString() ?? ''
  }
}

export async function getStackDriftSummary(
  connection: AwsConnection,
  stackName: string
): Promise<CloudFormationStackDriftSummary> {
  const client = getAwsClient(CloudFormationClient, connection)
  const output = await client.send(new DescribeStacksCommand({ StackName: stackName }))
  const stack = output.Stacks?.[0]
  return mapStackDriftSummary(stack ?? {}, stackName)
}

export async function startStackDriftDetection(
  connection: AwsConnection,
  stackName: string
): Promise<string> {
  const client = getAwsClient(CloudFormationClient, connection)
  const output = await client.send(new DetectStackDriftCommand({ StackName: stackName }))
  return output.StackDriftDetectionId ?? ''
}

function buildDriftDetails(row: {
  StackResourceDriftStatus?: string
  PropertyDifferences?: Array<{
    PropertyPath?: string
    ActualValue?: string
    ExpectedValue?: string
    DifferenceType?: string
  }>
  DriftStatusReason?: string
}): string {
  function stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      return `{${entries.join(',')}}`
    }

    return JSON.stringify(value)
  }

  function shortHash(value: string): string {
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16).padStart(8, '0')
  }

  function tryParseJson(value: string | undefined): unknown | null {
    if (!value) {
      return null
    }

    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  function summarizeJson(value: unknown): string {
    if (Array.isArray(value)) {
      const canonical = stableStringify(value)
      return `array(${value.length}, sig ${shortHash(canonical)})`
    }

    if (value && typeof value === 'object') {
      const keys = Object.keys(value as Record<string, unknown>)
      const canonical = stableStringify(value)
      return `object(${keys.length} keys: ${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''}; sig ${shortHash(canonical)})`
    }

    return String(value)
  }

  function compactValue(value: string | undefined): string {
    if (!value) {
      return ''
    }

    const parsed = tryParseJson(value)
    if (parsed !== null) {
      return summarizeJson(parsed)
    }

    const normalized = value.replace(/\s+/g, ' ').trim()
    return normalized.length > 140 ? `${normalized.slice(0, 137)}...` : normalized
  }

  const differences = row.PropertyDifferences ?? []
  if (differences.length > 0) {
    return differences
      .slice(0, 3)
      .map((difference) => {
        const expectedSummary = compactValue(difference.ExpectedValue)
        const actualSummary = compactValue(difference.ActualValue)

        return [
          `${difference.PropertyPath ?? '-'} changed`,
          difference.DifferenceType ? `type ${difference.DifferenceType}` : '',
          expectedSummary ? `expected: ${expectedSummary}` : '',
          actualSummary ? `actual: ${actualSummary}` : ''
        ].filter(Boolean).join(' | ')
      })
      .join(' ; ')
  }

  if (row.DriftStatusReason) {
    return compactValue(row.DriftStatusReason)
  }

  return row.StackResourceDriftStatus ?? '-'
}

async function listDriftedResources(
  client: CloudFormationClient,
  stackName: string
): Promise<CloudFormationDriftedResourceRow[]> {
  const rows: CloudFormationDriftedResourceRow[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeStackResourceDriftsCommand({
      StackName: stackName,
      NextToken: nextToken
    }))

    for (const drift of output.StackResourceDrifts ?? []) {
      const driftStatus = drift.StackResourceDriftStatus ?? 'UNKNOWN'
      if (driftStatus === 'IN_SYNC') {
        continue
      }

      rows.push({
        logicalResourceId: drift.LogicalResourceId ?? '-',
        physicalResourceId: drift.PhysicalResourceId ?? '-',
        resourceType: drift.ResourceType ?? '-',
        driftStatus,
        details: buildDriftDetails(drift),
        propertyDifferences: (drift.PropertyDifferences ?? []).map((difference) => ({
          propertyPath: difference.PropertyPath ?? '-',
          expectedValue: difference.ExpectedValue ?? '',
          actualValue: difference.ActualValue ?? '',
          differenceType: difference.DifferenceType ?? '-'
        })),
        rawJson: JSON.stringify(drift, null, 2)
      })
    }

    nextToken = output.NextToken
  } while (nextToken)

  return rows
}

export async function getStackDriftDetectionStatus(
  connection: AwsConnection,
  stackName: string,
  driftDetectionId: string
): Promise<{ summary: CloudFormationStackDriftSummary; rows: CloudFormationDriftedResourceRow[] }> {
  const client = getAwsClient(CloudFormationClient, connection)
  const output = await client.send(new DescribeStackDriftDetectionStatusCommand({
    StackDriftDetectionId: driftDetectionId
  }))
  const summary = mapStackDriftSummary({
    StackName: stackName,
    StackId: output.StackId,
    StackDriftStatus: output.StackDriftStatus,
    LastCheckTimestamp: output.Timestamp,
    StackDriftDetectionId: driftDetectionId,
    DetectionStatus: output.DetectionStatus,
    DetectionStatusReason: output.DetectionStatusReason
  }, stackName)

  if (summary.detectionStatus !== 'DETECTION_COMPLETE') {
    return {
      summary,
      rows: []
    }
  }

  return {
    summary,
    rows: await listDriftedResources(client, stackName)
  }
}
