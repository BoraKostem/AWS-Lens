import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { app } from 'electron'
import type { ExportEventKind, ExportQueueEntry } from '@shared/types'
import type { NormalizedExportDocument } from './schema'

const MAX_QUEUE_SIZE = 10_000
const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 5_000

// Exponential backoff: 5s, 25s, 125s, 625s, 3125s
function nextAttemptDelay(attempts: number): number {
  return BASE_BACKOFF_MS * Math.pow(5, attempts)
}

function queuePath(): string {
  return path.join(app.getPath('userData'), 'exporter-queue.json')
}

let healthDropped = 0

// In-memory snapshot of the queue to avoid hammering disk for every enqueue.
// On startup we lazy-load from disk; on mutation we write back atomically.
let cache: ExportQueueEntry[] | null = null

function loadCache(): ExportQueueEntry[] {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(queuePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    cache = Array.isArray(parsed) ? (parsed as ExportQueueEntry[]) : []
  } catch {
    cache = []
  }
  return cache
}

function persist(): void {
  if (!cache) return
  const tmpPath = queuePath() + '.tmp'
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), 'utf-8')
    fs.renameSync(tmpPath, queuePath())
  } catch {
    // If write fails we retain the in-memory queue; next mutation will retry persistence.
  }
}

export function getDroppedCount(): number {
  return healthDropped
}

export function enqueue(kind: ExportEventKind, payload: NormalizedExportDocument): void {
  const entries = loadCache()
  const id = (payload._id as string) || randomUUID()

  // Idempotent upsert: if an entry with the same id is already queued, replace its
  // payload with the latest version so retries use the freshest document.
  const existingIdx = entries.findIndex((e) => e.id === id)
  if (existingIdx !== -1) {
    entries[existingIdx] = {
      ...entries[existingIdx],
      payload,
      // Preserve attempts and nextAttemptAt so backoff pacing remains intact.
    }
    persist()
    return
  }

  if (entries.length >= MAX_QUEUE_SIZE) {
    // Drop oldest retried entries first (highest attempts, oldest createdAt).
    entries.sort((a, b) => b.attempts - a.attempts || a.createdAt.localeCompare(b.createdAt))
    const toRemoveCount = Math.ceil(MAX_QUEUE_SIZE * 0.1)
    entries.splice(0, toRemoveCount)
    healthDropped += toRemoveCount
  }

  entries.push({
    id,
    kind,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    nextAttemptAt: new Date().toISOString(),
    lastError: ''
  })
  persist()
}

export function peekDue(limit = 50): ExportQueueEntry[] {
  const now = new Date().toISOString()
  // FIFO by createdAt so catch-up sync delivers oldest events first.
  return loadCache()
    .filter((e) => e.nextAttemptAt <= now)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, limit)
}

export function markSuccess(id: string): void {
  const entries = loadCache()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return
  entries.splice(idx, 1)
  persist()
}

export function markFailure(id: string, error: string, fatal = false): void {
  const entries = loadCache()
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return

  const entry = entries[idx]
  const attempts = entry.attempts + 1

  if (fatal || attempts >= MAX_ATTEMPTS) {
    entries.splice(idx, 1)
    healthDropped++
  } else {
    const delay = nextAttemptDelay(attempts)
    entries[idx] = {
      ...entry,
      attempts,
      nextAttemptAt: new Date(Date.now() + delay).toISOString(),
      lastError: error
    }
  }

  persist()
}

export function queueStats(): { pending: number; retrying: number; dropped: number } {
  const entries = loadCache()
  const now = new Date().toISOString()
  const pending = entries.filter((e) => e.nextAttemptAt <= now).length
  const retrying = entries.filter((e) => e.nextAttemptAt > now).length
  return { pending, retrying, dropped: healthDropped }
}

export function purgeQueue(): void {
  cache = []
  persist()
  healthDropped = 0
}

export function drainOldEntries(retentionHours: number): void {
  if (retentionHours <= 0) return
  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString()
  const entries = loadCache()
  const filtered = entries.filter((e) => e.createdAt >= cutoff)
  if (filtered.length !== entries.length) {
    healthDropped += entries.length - filtered.length
    cache = filtered
    persist()
  }
}
