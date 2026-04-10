import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  BatchDeleteImageCommand,
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  DescribeImageScanFindingsCommand,
  DescribeImagesCommand,
  DescribeRepositoriesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
  ListTagsForResourceCommand,
  StartImageScanCommand
} from '@aws-sdk/client-ecr'

import { getAwsClient } from './client'
import type {
  AwsConnection,
  EcrAuthorizationData,
  EcrImageSummary,
  EcrRepositorySummary,
  EcrScanResult
} from '@shared/types'
import { getToolCommand } from '../toolchain'

const execFileAsync = promisify(execFile)
const dockerCommand = () => getToolCommand('docker', 'docker')

export async function listEcrRepositories(connection: AwsConnection): Promise<EcrRepositorySummary[]> {
  const client = getAwsClient(ECRClient, connection)
  const repos: EcrRepositorySummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(new DescribeRepositoriesCommand({ nextToken }))
    for (const repo of output.repositories ?? []) {
      let tags: Record<string, string> = {}
      if (repo.repositoryArn) {
        try {
          const tagOutput = await client.send(new ListTagsForResourceCommand({ resourceArn: repo.repositoryArn }))
          tags = Object.fromEntries((tagOutput.tags ?? []).flatMap((tag) => tag.Key ? [[tag.Key, tag.Value ?? '']] : []))
        } catch {
          tags = {}
        }
      }
      repos.push({
        repositoryName: repo.repositoryName ?? '-',
        repositoryUri: repo.repositoryUri ?? '-',
        registryId: repo.registryId ?? '-',
        imageCount: 0,
        createdAt: repo.createdAt?.toISOString() ?? '-',
        imageTagMutability: repo.imageTagMutability ?? 'MUTABLE',
        scanOnPush: repo.imageScanningConfiguration?.scanOnPush ?? false,
        tags
      })
    }
    nextToken = output.nextToken
  } while (nextToken)

  return repos
}

export async function listEcrImages(
  connection: AwsConnection,
  repositoryName: string
): Promise<EcrImageSummary[]> {
  const client = getAwsClient(ECRClient, connection)
  const images: EcrImageSummary[] = []
  let nextToken: string | undefined

  do {
    const output = await client.send(
      new DescribeImagesCommand({ repositoryName, nextToken })
    )
    for (const img of output.imageDetails ?? []) {
      images.push({
        imageDigest: img.imageDigest ?? '-',
        imageTags: img.imageTags ?? [],
        pushedAt: img.imagePushedAt?.toISOString() ?? '-',
        sizeBytes: img.imageSizeInBytes ?? 0,
        scanStatus: img.imageScanStatus?.status ?? 'NOT_SCANNED',
        lastScanAt: img.imageScanFindingsSummary?.imageScanCompletedAt?.toISOString() ?? '-',
        lastPull: (img as Record<string, unknown>).lastRecordedPullTime
          ? new Date((img as Record<string, unknown>).lastRecordedPullTime as string).toISOString()
          : '-'
      })
    }
    nextToken = output.nextToken
  } while (nextToken)

  images.sort((a, b) => (b.pushedAt > a.pushedAt ? 1 : -1))
  return images
}

export async function createEcrRepository(
  connection: AwsConnection,
  repositoryName: string,
  imageTagMutability: string,
  scanOnPush: boolean
): Promise<void> {
  const client = getAwsClient(ECRClient, connection)
  await client.send(
    new CreateRepositoryCommand({
      repositoryName,
      imageTagMutability: imageTagMutability as 'MUTABLE' | 'IMMUTABLE',
      imageScanningConfiguration: { scanOnPush }
    })
  )
}

export async function deleteEcrRepository(
  connection: AwsConnection,
  repositoryName: string,
  force: boolean
): Promise<void> {
  const client = getAwsClient(ECRClient, connection)
  await client.send(new DeleteRepositoryCommand({ repositoryName, force }))
}

export async function deleteEcrImage(
  connection: AwsConnection,
  repositoryName: string,
  imageDigest: string
): Promise<void> {
  const client = getAwsClient(ECRClient, connection)
  await client.send(
    new BatchDeleteImageCommand({
      repositoryName,
      imageIds: [{ imageDigest }]
    })
  )
}

export async function startEcrImageScan(
  connection: AwsConnection,
  repositoryName: string,
  imageDigest: string,
  imageTag?: string
): Promise<void> {
  const client = getAwsClient(ECRClient, connection)
  await client.send(
    new StartImageScanCommand({
      repositoryName,
      imageId: { imageDigest, imageTag }
    })
  )
}

export async function getEcrScanFindings(
  connection: AwsConnection,
  repositoryName: string,
  imageDigest: string
): Promise<EcrScanResult> {
  const client = getAwsClient(ECRClient, connection)
  const findings: EcrScanResult['findings'] = []
  let nextToken: string | undefined

  let scanStatus = ''
  let scanCompletedAt = ''
  let findingCounts: Record<string, number> = {}

  do {
    const output = await client.send(
      new DescribeImageScanFindingsCommand({
        repositoryName,
        imageId: { imageDigest },
        nextToken
      })
    )

    scanStatus = output.imageScanStatus?.status ?? 'UNKNOWN'
    scanCompletedAt = output.imageScanFindings?.imageScanCompletedAt?.toISOString() ?? '-'

    const rawCounts = output.imageScanFindings?.findingSeverityCounts ?? {}
    findingCounts = Object.fromEntries(
      Object.entries(rawCounts).map(([k, v]) => [k, v ?? 0])
    )

    for (const f of output.imageScanFindings?.findings ?? []) {
      findings.push({
        name: f.name ?? '-',
        severity: f.severity ?? 'UNDEFINED',
        description: f.description ?? '-',
        uri: f.uri ?? '',
        package: f.attributes?.find((a) => a.key === 'package_name')?.value ?? '-',
        packageVersion: f.attributes?.find((a) => a.key === 'package_version')?.value ?? '-'
      })
    }

    nextToken = output.nextToken
  } while (nextToken)

  return { imageDigest, scanStatus, findingCounts, findings, scanCompletedAt }
}

export async function getEcrAuthorizationToken(
  connection: AwsConnection
): Promise<EcrAuthorizationData> {
  const client = getAwsClient(ECRClient, connection)
  const output = await client.send(new GetAuthorizationTokenCommand({}))
  const auth = output.authorizationData?.[0]

  if (!auth) {
    throw new Error('No authorization data returned from ECR')
  }

  const token = auth.authorizationToken ?? ''
  const proxyEndpoint = auth.proxyEndpoint ?? ''
  const expiresAt = auth.expiresAt?.toISOString() ?? '-'

  const decoded = Buffer.from(token, 'base64').toString('utf-8')
  const [user, password] = decoded.split(':')
  const loginCommand = `${JSON.stringify(dockerCommand())} login -u ${user} -p ${password} ${proxyEndpoint}`

  return { proxyEndpoint, token, expiresAt, loginCommand }
}

export async function dockerLogin(connection: AwsConnection): Promise<string> {
  const auth = await getEcrAuthorizationToken(connection)
  const decoded = Buffer.from(auth.token, 'base64').toString('utf-8')
  const [user, password] = decoded.split(':')
  const { stdout, stderr } = await execFileAsync(dockerCommand(), ['login', '-u', user, '-p', password, auth.proxyEndpoint])
  return (stdout || stderr).trim()
}

export async function dockerPull(
  repositoryUri: string,
  tag: string
): Promise<string> {
  const image = `${repositoryUri}:${tag}`
  const { stdout, stderr } = await execFileAsync(dockerCommand(), ['pull', image])
  return (stdout || stderr).trim()
}

export async function dockerPushLocal(
  localImage: string,
  repositoryUri: string,
  tag: string
): Promise<string> {
  const target = `${repositoryUri}:${tag}`
  await execFileAsync(dockerCommand(), ['tag', localImage, target])
  const { stdout, stderr } = await execFileAsync(dockerCommand(), ['push', target])
  return (stdout || stderr).trim()
}
