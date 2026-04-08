import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'
import type { TerraformRunRecord, TerraformRunHistoryFilter } from '@shared/types'
import { logWarn } from './observability'

const MAX_RECORDS = 500

function indexPath(): string {
  return path.join(app.getPath('userData'), 'terraform-run-history.json')
}

function outputDir(): string {
  return path.join(app.getPath('userData'), 'terraform-run-outputs')
}

function outputFilePath(runId: string): string {
  return path.join(outputDir(), `${runId}.txt`)
}

function ensureOutputDir(): void {
  const dir = outputDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function readIndex(): TerraformRunRecord[] {
  try {
    const raw = fs.readFileSync(indexPath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as TerraformRunRecord[]
  } catch (error) {
    logWarn('terraformHistoryStore.readIndex', 'Failed to read or parse run history index.', { indexPath: indexPath() }, error)
    return []
  }
}

function writeIndex(records: TerraformRunRecord[]): void {
  fs.writeFileSync(indexPath(), JSON.stringify(records, null, 2), 'utf-8')
}

const SECRET_PATTERN = /^TF_VAR_(password|secret|token|key|api_key|private|credentials?)/i

export function redactArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (SECRET_PATTERN.test(arg)) return arg.replace(/=.*/, '=***')
    return arg
  })
}

export function saveRunRecord(record: TerraformRunRecord, output: string): void {
  ensureOutputDir()

  const records = readIndex()
  records.unshift(record)
  const trimmed = records.slice(0, MAX_RECORDS)

  // Remove output files for pruned records
  const prunedIds = new Set(records.slice(MAX_RECORDS).map((r) => r.id))
  for (const id of prunedIds) {
    try {
      fs.unlinkSync(outputFilePath(id))
    } catch {
      /* ok */
    }
  }

  writeIndex(trimmed)
  fs.writeFileSync(outputFilePath(record.id), output, 'utf-8')
}

export function updateRunRecord(id: string, updates: Partial<TerraformRunRecord>, output?: string): void {
  const records = readIndex()
  const idx = records.findIndex((r) => r.id === id)
  if (idx === -1) return
  Object.assign(records[idx], updates)
  writeIndex(records)

  if (output !== undefined) {
    ensureOutputDir()
    fs.writeFileSync(outputFilePath(id), output, 'utf-8')
  }
}

export function listRunRecords(filter?: TerraformRunHistoryFilter): TerraformRunRecord[] {
  let records = readIndex()
  if (filter?.projectId) {
    records = records.filter((r) => r.projectId === filter.projectId)
  }
  if (filter?.command) {
    records = records.filter((r) => r.command === filter.command)
  }
  if (filter?.success !== undefined) {
    records = records.filter((r) => r.success === filter.success)
  }
  return records
}

export function getRunOutput(runId: string): string {
  try {
    return fs.readFileSync(outputFilePath(runId), 'utf-8')
  } catch {
    return ''
  }
}

export function deleteRunRecord(runId: string): void {
  const records = readIndex()
  const filtered = records.filter((r) => r.id !== runId)
  writeIndex(filtered)
  try {
    fs.unlinkSync(outputFilePath(runId))
  } catch {
    /* ok */
  }
}
