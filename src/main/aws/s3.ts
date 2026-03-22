import type { BucketLocationConstraint } from '@aws-sdk/client-s3'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketLocationCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { createWriteStream } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

import type { AwsConnection, S3BucketSummary, S3ObjectContent, S3ObjectSummary } from '@shared/types'
import { awsClientConfig } from './client'

function createClient(connection: AwsConnection): S3Client {
  return new S3Client(awsClientConfig(connection))
}

/* ── Buckets ─────────────────────────────────────────────── */

export async function listBuckets(connection: AwsConnection): Promise<S3BucketSummary[]> {
  const client = createClient(connection)
  const output = await client.send(new ListBucketsCommand({}))

  const buckets = await Promise.all((output.Buckets ?? []).map(async (bucket) => {
    const name = bucket.Name ?? '-'
    let region = connection.region

    if (name !== '-') {
      try {
        const location = await client.send(new GetBucketLocationCommand({ Bucket: name }))
        region = location.LocationConstraint || 'us-east-1'
      } catch {
        region = connection.region
      }
    }

    return {
      name,
      creationDate: bucket.CreationDate?.toISOString() ?? '-',
      region
    }
  }))

  return buckets.sort((left, right) => left.name.localeCompare(right.name))
}

export async function createBucket(connection: AwsConnection, bucketName: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new CreateBucketCommand({
    Bucket: bucketName,
    ...(connection.region !== 'us-east-1' && {
      CreateBucketConfiguration: {
        LocationConstraint: connection.region as BucketLocationConstraint
      }
    })
  }))
}

/* ── Objects ─────────────────────────────────────────────── */

export async function listBucketObjects(
  connection: AwsConnection,
  bucketName: string,
  prefix = ''
): Promise<S3ObjectSummary[]> {
  const client = createClient(connection)
  const objects: S3ObjectSummary[] = []
  let continuationToken: string | undefined

  /* Collect folders (common prefixes) */
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
      const p = cp.Prefix ?? ''
      if (p && !folderSet.has(p)) {
        folderSet.add(p)
        const parts = p.replace(/\/$/, '').split('/')
        objects.push({
          key: p,
          size: 0,
          lastModified: '-',
          storageClass: '-',
          isFolder: true
        })
      }
    }

    for (const item of output.Contents ?? []) {
      const key = item.Key ?? ''
      if (key === prefix) continue // skip the prefix itself
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

  // Folders first, then files, each sorted by key
  const folders = objects.filter(o => o.isFolder).sort((a, b) => a.key.localeCompare(b.key))
  const files = objects.filter(o => !o.isFolder).sort((a, b) => a.key.localeCompare(b.key))
  return [...folders, ...files]
}

export async function deleteObject(connection: AwsConnection, bucketName: string, key: string): Promise<void> {
  const client = createClient(connection)
  await client.send(new DeleteObjectCommand({ Bucket: bucketName, Key: key }))
}

export async function getPresignedUrl(
  connection: AwsConnection,
  bucketName: string,
  key: string,
  expiresIn = 3600
): Promise<string> {
  const client = createClient(connection)
  const command = new GetObjectCommand({ Bucket: bucketName, Key: key })
  return getSignedUrl(client, command, { expiresIn })
}

export async function createFolder(connection: AwsConnection, bucketName: string, folderKey: string): Promise<void> {
  const client = createClient(connection)
  const key = folderKey.endsWith('/') ? folderKey : folderKey + '/'
  await client.send(new PutObjectCommand({ Bucket: bucketName, Key: key, Body: '' }))
}

/* ── Download ────────────────────────────────────────────── */

export async function downloadObject(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<string> {
  const client = createClient(connection)
  const output = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: key }))

  const fileName = key.split('/').pop() || 'download'
  const tempDir = app.getPath('temp')
  const filePath = join(tempDir, `s3-${Date.now()}-${fileName}`)

  if (output.Body instanceof Readable) {
    const ws = createWriteStream(filePath)
    await pipeline(output.Body, ws)
  } else if (output.Body) {
    const bytes = await output.Body.transformToByteArray()
    await writeFile(filePath, Buffer.from(bytes))
  }

  return filePath
}

export async function downloadObjectToPath(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<string> {
  const fileName = key.split('/').pop() || 'download'
  const win = BrowserWindow.getFocusedWindow()
  const result = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0], {
    defaultPath: fileName,
    title: 'Save S3 Object'
  })

  if (result.canceled || !result.filePath) return ''

  const client = createClient(connection)
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

export async function openInVSCode(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<string> {
  const filePath = await downloadObject(connection, bucketName, key)
  void shell.openExternal(`vscode://file/${filePath}`)
  return filePath
}

/* ── Get / Put text content ──────────────────────────────── */

export async function getObjectContent(
  connection: AwsConnection,
  bucketName: string,
  key: string
): Promise<S3ObjectContent> {
  const client = createClient(connection)
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
  const client = createClient(connection)
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: content,
    ContentType: contentType ?? 'text/plain'
  }))
}

/* ── Upload from local file ──────────────────────────────── */

export async function uploadObject(
  connection: AwsConnection,
  bucketName: string,
  key: string,
  localPath: string
): Promise<void> {
  const client = createClient(connection)
  const fileBuffer = await readFile(localPath)
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: fileBuffer
  }))
}
