import { execFile } from 'node:child_process'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  DeleteClusterCommand,
  DescribeClusterCommand,
  DescribeNodegroupCommand,
  DescribeUpdateCommand,
  EKSClient,
  ListClustersCommand,
  ListNodegroupsCommand,
  ListUpdatesCommand,
  UpdateNodegroupConfigCommand
} from '@aws-sdk/client-eks'

import { awsClientConfig } from './client'
import { readTags } from './client'
import type {
  AwsConnection,
  EksClusterDetail,
  EksClusterSummary,
  EksNodegroupSummary,
  EksUpdateEvent
} from '@shared/types'
import { launchKubectlShell } from '../shell'
import { getConnectionEnv } from '../sessionHub'

const execFileAsync = promisify(execFile)

function createClient(connection: AwsConnection): EKSClient {
  return new EKSClient(awsClientConfig(connection))
}

export async function listEksClusters(connection: AwsConnection): Promise<EksClusterSummary[]> {
  const client = createClient(connection)
  const clusters: EksClusterSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new ListClustersCommand({ nextToken }))
    for (const name of output.clusters ?? []) {
      const detail = await describeEksClusterRaw(connection, name)
      clusters.push({
        name: detail?.name ?? name,
        status: detail?.status ?? '-',
        version: detail?.version ?? '-',
        endpoint: detail?.endpoint ?? '-',
        roleArn: detail?.roleArn ?? '-'
      })
    }
    nextToken = output.nextToken
  } while (nextToken)

  return clusters
}

async function describeEksClusterRaw(connection: AwsConnection, clusterName: string) {
  const client = createClient(connection)
  const output = await client.send(new DescribeClusterCommand({ name: clusterName }))
  return output.cluster ?? null
}

export async function describeEksCluster(
  connection: AwsConnection,
  clusterName: string
): Promise<EksClusterDetail> {
  const raw = await describeEksClusterRaw(connection, clusterName)
  const vpc = raw?.resourcesVpcConfig
  const logging = raw?.logging?.clusterLogging ?? []
  const enabledLogs = logging
    .filter((entry) => entry.enabled)
    .flatMap((entry) => entry.types ?? [])

  return {
    name: raw?.name ?? clusterName,
    status: raw?.status ?? '-',
    version: raw?.version ?? '-',
    platformVersion: raw?.platformVersion ?? '-',
    endpoint: raw?.endpoint ?? '-',
    roleArn: raw?.roleArn ?? '-',
    createdAt: raw?.createdAt?.toISOString() ?? '-',
    vpcId: vpc?.vpcId ?? '-',
    subnetIds: vpc?.subnetIds ?? [],
    securityGroupIds: vpc?.securityGroupIds ?? [],
    clusterSecurityGroupId: vpc?.clusterSecurityGroupId ?? '-',
    serviceIpv4Cidr: raw?.kubernetesNetworkConfig?.serviceIpv4Cidr ?? '-',
    endpointPublicAccess: vpc?.endpointPublicAccess ?? false,
    endpointPrivateAccess: vpc?.endpointPrivateAccess ?? false,
    publicAccessCidrs: vpc?.publicAccessCidrs ?? [],
    loggingEnabled: enabledLogs,
    tags: readTags(
      raw?.tags
        ? Object.entries(raw.tags).map(([Key, Value]) => ({ Key, Value }))
        : []
    ),
    oidcIssuer: raw?.identity?.oidc?.issuer ?? '-'
  }
}

export async function listEksNodegroups(
  connection: AwsConnection,
  clusterName: string
): Promise<EksNodegroupSummary[]> {
  const client = createClient(connection)
  const output = await client.send(new ListNodegroupsCommand({ clusterName }))
  const nodegroups: EksNodegroupSummary[] = []

  for (const name of output.nodegroups ?? []) {
    const detail = await client.send(
      new DescribeNodegroupCommand({
        clusterName,
        nodegroupName: name
      })
    )
    const nodegroup = detail.nodegroup
    nodegroups.push({
      name: nodegroup?.nodegroupName ?? name,
      status: nodegroup?.status ?? '-',
      min: nodegroup?.scalingConfig?.minSize ?? '-',
      desired: nodegroup?.scalingConfig?.desiredSize ?? '-',
      max: nodegroup?.scalingConfig?.maxSize ?? '-',
      instanceTypes: nodegroup?.instanceTypes?.join(', ') || '-'
    })
  }

  return nodegroups
}

export async function updateEksNodegroupScaling(
  connection: AwsConnection,
  clusterName: string,
  nodegroupName: string,
  minimum: number,
  desired: number,
  maximum: number
) {
  const client = createClient(connection)
  const output = await client.send(
    new UpdateNodegroupConfigCommand({
      clusterName,
      nodegroupName,
      scalingConfig: {
        minSize: minimum,
        desiredSize: desired,
        maxSize: maximum
      }
    })
  )

  return output.update ?? null
}

export async function listEksUpdates(
  connection: AwsConnection,
  clusterName: string
): Promise<EksUpdateEvent[]> {
  const client = createClient(connection)
  const listOutput = await client.send(new ListUpdatesCommand({ name: clusterName }))
  const events: EksUpdateEvent[] = []

  for (const updateId of listOutput.updateIds ?? []) {
    const detail = await client.send(
      new DescribeUpdateCommand({ name: clusterName, updateId })
    )
    const update = detail.update
    events.push({
      id: update?.id ?? updateId,
      type: update?.type ?? '-',
      status: update?.status ?? '-',
      createdAt: update?.createdAt?.toISOString() ?? '-',
      params: (update?.params ?? []).map((p) => ({
        type: p.type ?? '-',
        value: p.value ?? '-'
      })),
      errors: (update?.errors ?? []).map(
        (e) => `${e.errorCode ?? ''}: ${e.errorMessage ?? ''}`.trim()
      )
    })
  }

  events.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))
  return events
}

export async function deleteEksCluster(connection: AwsConnection, clusterName: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteClusterCommand({ name: clusterName }))
}

export async function addEksToKubeconfig(
  connection: AwsConnection,
  clusterName: string,
  contextName: string,
  kubeconfigPath: string
): Promise<string> {
  const normalizedContextName = contextName.trim()
  const targetKubeconfigPath = resolveKubeconfigPath(kubeconfigPath)
  await mkdir(dirname(targetKubeconfigPath), { recursive: true })

  const args = [
    'eks', 'update-kubeconfig',
    '--name', clusterName,
    '--region', connection.region,
    '--alias', normalizedContextName,
    '--kubeconfig', targetKubeconfigPath
  ]
  if (connection.kind === 'profile') {
    args.push('--profile', connection.profile)
  }
  const { stdout, stderr } = await execFileAsync('aws', args, {
    env: {
      ...process.env,
      ...getConnectionEnv(connection)
    }
  })
  return (stdout || stderr).trim()
}

function sanitizeClusterName(clusterName: string): string {
  return clusterName.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function resolveKubeconfigPath(kubeconfigPath: string): string {
  const trimmed = kubeconfigPath.trim()

  if (!trimmed) {
    return join(homedir(), '.kube', 'config')
  }

  if (trimmed === '.kube/config' || trimmed === '.kube\\config') {
    return join(homedir(), '.kube', 'config')
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2))
  }

  if (isAbsolute(trimmed)) {
    return trimmed
  }

  return resolve(homedir(), trimmed)
}

export async function createTempEksKubeconfig(
  connection: AwsConnection,
  clusterName: string
): Promise<{ path: string; output: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), 'eks-kubeconfig-'))
  const kubeconfigPath = join(tempDir, `${sanitizeClusterName(clusterName)}.yaml`)
  const args = [
    'eks',
    'update-kubeconfig',
    '--name',
    clusterName,
    '--region',
    connection.region,
    '--kubeconfig',
    kubeconfigPath
  ]
  if (connection.kind === 'profile') {
    args.splice(6, 0, '--profile', connection.profile)
  }

  const { stdout, stderr } = await execFileAsync('aws', args, {
    env: {
      ...process.env,
      ...getConnectionEnv(connection)
    }
  })

  return {
    path: kubeconfigPath,
    output: (stdout || stderr).trim()
  }
}

export async function launchKubectlTerminal(
  connection: AwsConnection,
  clusterName: string
): Promise<void> {
  const kubeconfig = await createTempEksKubeconfig(connection, clusterName)
  await launchKubectlShell(connection, clusterName, kubeconfig.path)
}
