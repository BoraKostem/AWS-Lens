import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { app } from 'electron'

import type {
  ComparisonBaseline,
  ComparisonBaselineInput,
  ComparisonBaselineSummary
} from '@shared/types'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

type ComparisonBaselineState = {
  baselines: ComparisonBaseline[]
}

const DEFAULT_STATE: ComparisonBaselineState = {
  baselines: []
}

function baselinePath(): string {
  return path.join(app.getPath('userData'), 'compare-baselines.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function sanitizeBaseline(value: unknown): ComparisonBaseline | null {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return null
  }

  const id = sanitizeString(raw.id)
  const name = sanitizeString(raw.name)
  const generatedAt = sanitizeString(raw.generatedAt)
  const createdAt = sanitizeString(raw.createdAt)
  const updatedAt = sanitizeString(raw.updatedAt)
  const leftLabel = sanitizeString(raw.leftLabel)
  const rightLabel = sanitizeString(raw.rightLabel)
  const request = raw.request
  const result = raw.result

  if (!id || !name || !generatedAt || !createdAt || !updatedAt || !leftLabel || !rightLabel || !request || !result) {
    return null
  }

  return {
    id,
    name,
    description: sanitizeString(raw.description),
    generatedAt,
    createdAt,
    updatedAt,
    leftLabel,
    rightLabel,
    request: request as ComparisonBaseline['request'],
    result: result as ComparisonBaseline['result']
  }
}

function sanitizeState(value: unknown): ComparisonBaselineState {
  const raw = isRecord(value) ? value : {}
  return {
    baselines: Array.isArray(raw.baselines)
      ? raw.baselines
        .map((entry) => sanitizeBaseline(entry))
        .filter((entry): entry is ComparisonBaseline => Boolean(entry))
      : []
  }
}

function readState(): ComparisonBaselineState {
  return sanitizeState(readSecureJsonFile<ComparisonBaselineState>(baselinePath(), {
    fallback: DEFAULT_STATE,
    fileLabel: 'Compare baselines'
  }))
}

function writeState(state: ComparisonBaselineState): ComparisonBaselineState {
  const sanitized = sanitizeState(state)
  writeSecureJsonFile(baselinePath(), sanitized, 'Compare baselines')
  return sanitized
}

function toSummary(baseline: ComparisonBaseline): ComparisonBaselineSummary {
  return {
    id: baseline.id,
    name: baseline.name,
    description: baseline.description,
    generatedAt: baseline.generatedAt,
    createdAt: baseline.createdAt,
    updatedAt: baseline.updatedAt,
    leftLabel: baseline.leftLabel,
    rightLabel: baseline.rightLabel
  }
}

function sortBaselines(baselines: ComparisonBaseline[]): ComparisonBaseline[] {
  return [...baselines].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name)
  )
}

export function listComparisonBaselines(): ComparisonBaselineSummary[] {
  return sortBaselines(readState().baselines).map((baseline) => toSummary(baseline))
}

export function getComparisonBaseline(id: string): ComparisonBaseline | null {
  const normalizedId = id.trim()
  if (!normalizedId) {
    return null
  }

  return readState().baselines.find((baseline) => baseline.id === normalizedId) ?? null
}

export function saveComparisonBaseline(input: ComparisonBaselineInput): ComparisonBaselineSummary {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Comparison baseline name is required.')
  }

  const state = readState()
  const now = new Date().toISOString()
  const existingId = input.id?.trim() ?? ''
  const existing = existingId
    ? state.baselines.find((baseline) => baseline.id === existingId)
    : null
  const result = input.result
  const nextBaseline: ComparisonBaseline = {
    id: existing?.id ?? randomUUID(),
    name,
    description: input.description.trim(),
    generatedAt: result.generatedAt,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    leftLabel: result.leftContext.label,
    rightLabel: result.rightContext.label,
    request: input.request,
    result
  }

  writeState({
    baselines: sortBaselines([
      ...state.baselines.filter((baseline) => baseline.id !== nextBaseline.id),
      nextBaseline
    ])
  })

  return toSummary(nextBaseline)
}

export function deleteComparisonBaseline(id: string): void {
  const normalizedId = id.trim()
  if (!normalizedId) {
    return
  }

  const state = readState()
  writeState({
    baselines: state.baselines.filter((baseline) => baseline.id !== normalizedId)
  })
}
