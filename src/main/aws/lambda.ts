import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  InvokeCommand,
  LambdaClient,
  ListFunctionsCommand,
  ListTagsCommand,
  type Runtime
} from '@aws-sdk/client-lambda'
import AdmZip from 'adm-zip'

import { getAwsClient } from './client'
import type {
  AwsConnection,
  LambdaCodeResult,
  LambdaCreateConfig,
  LambdaFunctionDetail,
  LambdaFunctionSummary,
  LambdaInvokeResult
} from '@shared/types'

export async function listLambdaFunctions(connection: AwsConnection): Promise<LambdaFunctionSummary[]> {
  const client = getAwsClient(LambdaClient, connection)
  const functions: LambdaFunctionSummary[] = []
  let marker: string | undefined

  do {
    const output = await client.send(new ListFunctionsCommand({ Marker: marker }))
    for (const fn of output.Functions ?? []) {
      let tags: Record<string, string> = {}
      if (fn.FunctionArn) {
        try {
          const tagOutput = await client.send(new ListTagsCommand({ Resource: fn.FunctionArn }))
          tags = tagOutput.Tags ?? {}
        } catch {
          tags = {}
        }
      }
      functions.push({
        functionName: fn.FunctionName ?? '-',
        handler: fn.Handler ?? '-',
        runtime: fn.Runtime ?? '-',
        memory: fn.MemorySize ?? '-',
        lastModified: fn.LastModified ?? '-',
        tags
      })
    }
    marker = output.NextMarker
  } while (marker)

  return functions
}

export async function getLambdaFunctionDetails(
  connection: AwsConnection,
  functionName: string
): Promise<LambdaFunctionDetail> {
  const client = getAwsClient(LambdaClient, connection)
  const output = await client.send(new GetFunctionCommand({ FunctionName: functionName }))
  const config = output.Configuration

  return {
    functionName: config?.FunctionName ?? functionName,
    functionArn: config?.FunctionArn ?? '-',
    runtime: config?.Runtime ?? '-',
    handler: config?.Handler ?? '-',
    role: config?.Role ?? '-',
    description: config?.Description ?? '',
    timeout: config?.Timeout ?? 0,
    memorySize: config?.MemorySize ?? 0,
    lastModified: config?.LastModified ?? '-',
    state: config?.State ?? '-',
    lastUpdateStatus: config?.LastUpdateStatus ?? '-',
    environment: config?.Environment?.Variables ?? {}
  }
}

export async function getLambdaFunctionCode(
  connection: AwsConnection,
  functionName: string
): Promise<LambdaCodeResult> {
  const client = getAwsClient(LambdaClient, connection)
  const output = await client.send(new GetFunctionCommand({ FunctionName: functionName }))
  const location = output.Code?.Location

  if (!location) {
    return { files: [], truncated: false }
  }

  const response = await fetch(location)
  if (!response.ok) {
    throw new Error(`Failed to download function code: ${response.statusText}`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const zip = new AdmZip(buffer)
  const entries = zip.getEntries()

  const TEXT_EXTENSIONS = new Set([
    '.py', '.js', '.ts', '.mjs', '.cjs', '.java', '.go', '.rb', '.cs',
    '.json', '.yaml', '.yml', '.xml', '.txt', '.md', '.cfg', '.ini',
    '.toml', '.sh', '.bat', '.ps1', '.html', '.css', '.sql', '.r',
    '.swift', '.kt', '.rs', '.lua', '.pl', '.pm', '.h', '.c', '.cpp',
    '.hpp', '.properties', '.env', '.lock', '.dockerfile', ''
  ])

  const MAX_FILE_SIZE = 512 * 1024 // 512 KB per file
  const MAX_FILES = 50
  const files: Array<{ path: string; content: string }> = []
  let truncated = false

  for (const entry of entries) {
    if (entry.isDirectory) continue
    if (files.length >= MAX_FILES) {
      truncated = true
      break
    }

    const ext = entry.entryName.includes('.')
      ? '.' + entry.entryName.split('.').pop()!.toLowerCase()
      : ''

    if (!TEXT_EXTENSIONS.has(ext)) continue

    const data = entry.getData()
    if (data.length > MAX_FILE_SIZE) {
      files.push({ path: entry.entryName, content: `[File too large: ${(data.length / 1024).toFixed(0)} KB]` })
      continue
    }

    files.push({ path: entry.entryName, content: data.toString('utf-8') })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, truncated }
}

export async function invokeLambdaFunction(
  connection: AwsConnection,
  functionName: string,
  payload = '{}'
): Promise<LambdaInvokeResult> {
  const client = getAwsClient(LambdaClient, connection)
  const output = await client.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: new TextEncoder().encode(payload)
    })
  )

  const rawPayload = output.Payload ? new TextDecoder().decode(output.Payload) : ''
  let parsedPayload: unknown = {}

  try {
    parsedPayload = rawPayload ? JSON.parse(rawPayload) : {}
  } catch {
    parsedPayload = rawPayload
  }

  return {
    statusCode: output.StatusCode ?? null,
    functionError: output.FunctionError ?? '',
    executedVersion: output.ExecutedVersion ?? '',
    payload: parsedPayload,
    rawPayload
  }
}

export async function createLambdaFunction(
  connection: AwsConnection,
  config: LambdaCreateConfig
): Promise<void> {
  const client = getAwsClient(LambdaClient, connection)

  // Create a zip with the code in a single file
  const zip = new AdmZip()
  const handlerFile = config.handler.split('.')[0]
  const extMap: Record<string, string> = {
    'python3.12': '.py', 'python3.11': '.py', 'python3.10': '.py', 'python3.9': '.py',
    'nodejs20.x': '.mjs', 'nodejs18.x': '.mjs', 'nodejs22.x': '.mjs',
    'ruby3.3': '.rb', 'ruby3.2': '.rb',
    'java21': '.java', 'java17': '.java',
    'dotnet8': '.cs', 'dotnet6': '.cs'
  }
  const ext = extMap[config.runtime] ?? '.py'
  zip.addFile(`${handlerFile}${ext}`, Buffer.from(config.code, 'utf-8'))

  await client.send(
    new CreateFunctionCommand({
      FunctionName: config.functionName,
      Runtime: config.runtime as Runtime,
      Role: config.role,
      Handler: config.handler,
      Code: { ZipFile: zip.toBuffer() },
      Description: config.description ?? '',
      Timeout: config.timeout ?? 30,
      MemorySize: config.memorySize ?? 128
    })
  )
}

export async function deleteLambdaFunction(
  connection: AwsConnection,
  functionName: string
): Promise<void> {
  const client = getAwsClient(LambdaClient, connection)
  await client.send(new DeleteFunctionCommand({ FunctionName: functionName }))
}
