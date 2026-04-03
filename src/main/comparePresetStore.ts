import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { app } from 'electron'

import type {
  ComparisonContextInput,
  ComparisonPreset,
  ComparisonPresetInput,
  ComparisonPresetSummary
} from '@shared/types'
import { readSecureJsonFile, writeSecureJsonFile } from './secureJson'

type ComparisonPresetState = {
  presets: ComparisonPreset[]
}

const DEFAULT_STATE: ComparisonPresetState = {
  presets: []
}

function presetPath(): string {
  return path.join(app.getPath('userData'), 'compare-presets.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function isComparisonContextInput(value: unknown): value is ComparisonContextInput {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return false
  }

  const kind = sanitizeString(raw.kind)
  const region = sanitizeString(raw.region)
  if (!kind || !region) {
    return false
  }

  if (kind === 'profile') {
    return Boolean(sanitizeString(raw.profile))
  }

  if (kind === 'assumed-role') {
    return Boolean(sanitizeString(raw.sessionId))
  }

  if (kind === 'saved-target') {
    return Boolean(sanitizeString(raw.targetId))
  }

  return false
}

function contextLabel(input: ComparisonContextInput): string {
  const customLabel = input.label?.trim()
  if (customLabel) {
    return customLabel
  }

  if (input.kind === 'profile') {
    return input.profile
  }

  if (input.kind === 'saved-target') {
    return input.targetId
  }

  return input.sessionId
}

function sanitizePreset(value: unknown): ComparisonPreset | null {
  const raw = isRecord(value) ? value : null
  if (!raw) {
    return null
  }

  const id = sanitizeString(raw.id)
  const name = sanitizeString(raw.name)
  const createdAt = sanitizeString(raw.createdAt)
  const updatedAt = sanitizeString(raw.updatedAt)
  const leftLabel = sanitizeString(raw.leftLabel)
  const rightLabel = sanitizeString(raw.rightLabel)
  const request = raw.request

  if (!id || !name || !createdAt || !updatedAt || !leftLabel || !rightLabel || !isRecord(request)) {
    return null
  }

  const left = request.left
  const right = request.right
  if (!isComparisonContextInput(left) || !isComparisonContextInput(right)) {
    return null
  }

  return {
    id,
    name,
    description: sanitizeString(raw.description),
    createdAt,
    updatedAt,
    leftLabel,
    rightLabel,
    request: {
      left,
      right
    }
  }
}

function sanitizeState(value: unknown): ComparisonPresetState {
  const raw = isRecord(value) ? value : {}
  return {
    presets: Array.isArray(raw.presets)
      ? raw.presets
          .map((entry) => sanitizePreset(entry))
          .filter((entry): entry is ComparisonPreset => Boolean(entry))
      : []
  }
}

function readState(): ComparisonPresetState {
  return sanitizeState(readSecureJsonFile<ComparisonPresetState>(presetPath(), {
    fallback: DEFAULT_STATE,
    fileLabel: 'Compare presets'
  }))
}

function writeState(state: ComparisonPresetState): ComparisonPresetState {
  const sanitized = sanitizeState(state)
  writeSecureJsonFile(presetPath(), sanitized, 'Compare presets')
  return sanitized
}

function toSummary(preset: ComparisonPreset): ComparisonPresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
    leftLabel: preset.leftLabel,
    rightLabel: preset.rightLabel
  }
}

function sortPresets(presets: ComparisonPreset[]): ComparisonPreset[] {
  return [...presets].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) || left.name.localeCompare(right.name)
  )
}

export function listComparisonPresets(): ComparisonPresetSummary[] {
  return sortPresets(readState().presets).map((preset) => toSummary(preset))
}

export function getComparisonPreset(id: string): ComparisonPreset | null {
  const normalizedId = id.trim()
  if (!normalizedId) {
    return null
  }

  return readState().presets.find((preset) => preset.id === normalizedId) ?? null
}

export function saveComparisonPreset(input: ComparisonPresetInput): ComparisonPresetSummary {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Comparison preset name is required.')
  }

  const state = readState()
  const now = new Date().toISOString()
  const existingId = input.id?.trim() ?? ''
  const existing = existingId
    ? state.presets.find((preset) => preset.id === existingId)
    : null
  const nextPreset: ComparisonPreset = {
    id: existing?.id ?? randomUUID(),
    name,
    description: input.description.trim(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    leftLabel: contextLabel(input.request.left),
    rightLabel: contextLabel(input.request.right),
    request: input.request
  }

  writeState({
    presets: sortPresets([
      ...state.presets.filter((preset) => preset.id !== nextPreset.id),
      nextPreset
    ])
  })

  return toSummary(nextPreset)
}

export function deleteComparisonPreset(id: string): void {
  const normalizedId = id.trim()
  if (!normalizedId) {
    return
  }

  const state = readState()
  writeState({
    presets: state.presets.filter((preset) => preset.id !== normalizedId)
  })
}
