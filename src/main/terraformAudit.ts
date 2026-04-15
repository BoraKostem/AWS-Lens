/**
 * Audit helper for terraform runs and drift reports.
 *
 * Responsibilities:
 *   - Build a mutable `TerraformAuditTraceContext` that threads through a run.
 *   - Emit structured `terraform.run.*` / `terraform.drift.*` log events.
 *   - Provide a `withAudit` wrapper for drift report entry points.
 */

import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

import type {
  TerraformAuditProviderId,
  TerraformAuditSummary,
  TerraformAuditTraceContext,
  TerraformErrorClass
} from '@shared/types'
import { logError, logInfo } from './observability'
import { classifyCloudSdkError } from './terraformErrorClassifier'

/**
 * Ambient trace context — populated by `withAudit` so nested SDK retry loops
 * (Azure `fetchAzureArmJson`, GCP `requestGcp`) can increment `retryCount`
 * without every call site having to thread an explicit parameter.
 */
const auditStore = new AsyncLocalStorage<TerraformAuditTraceContext>()

/** Returns the currently-active trace context, if any. Used by SDK retry loops. */
export function currentAuditContext(): TerraformAuditTraceContext | undefined {
  return auditStore.getStore()
}

/** Increment the ambient trace context's retry counter. No-op if no context is active. */
export function incrementAmbientRetryCount(): void {
  const ctx = auditStore.getStore()
  if (ctx) ctx.retryCount += 1
}

export type CreateTraceContextInput = {
  operation: string
  provider: TerraformAuditProviderId
  module: string
  resource?: string
  /** Supply to reuse an id generated earlier (e.g. the existing `TerraformCommandLog.id`). */
  traceId?: string
}

export function createTraceContext(input: CreateTraceContextInput): TerraformAuditTraceContext {
  return {
    traceId: input.traceId ?? randomUUID(),
    operation: input.operation,
    provider: input.provider,
    module: input.module,
    resource: input.resource ?? '',
    startedAtMs: Date.now(),
    retryCount: 0
  }
}

function contextPayload(ctx: TerraformAuditTraceContext, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    traceId: ctx.traceId,
    operation: ctx.operation,
    provider: ctx.provider,
    module: ctx.module,
    resource: ctx.resource || undefined,
    retryCount: ctx.retryCount,
    ...(extra ?? {})
  }
}

export function logRunStarted(ctx: TerraformAuditTraceContext, extra?: Record<string, unknown>): void {
  logInfo(`terraform.${ctx.operation === 'drift-report' ? 'drift' : 'run'}.started`,
    `Terraform ${ctx.operation} started.`, contextPayload(ctx, extra))
}

export function logRunCompleted(
  ctx: TerraformAuditTraceContext,
  durationMs: number,
  extra?: Record<string, unknown>
): void {
  logInfo(`terraform.${ctx.operation === 'drift-report' ? 'drift' : 'run'}.completed`,
    `Terraform ${ctx.operation} completed.`,
    contextPayload(ctx, { durationMs, ...(extra ?? {}) }))
}

export function logRunFailed(
  ctx: TerraformAuditTraceContext,
  durationMs: number,
  errorClass: TerraformErrorClass,
  suggestedAction: string,
  error: unknown,
  extra?: Record<string, unknown>
): void {
  logError(
    `terraform.${ctx.operation === 'drift-report' ? 'drift' : 'run'}.failed`,
    `Terraform ${ctx.operation} failed: ${errorClass}.`,
    contextPayload(ctx, { durationMs, errorClass, suggestedAction, ...(extra ?? {}) }),
    error
  )
}

export function buildAuditSummary(
  ctx: TerraformAuditTraceContext,
  durationMs: number,
  errorClass: TerraformErrorClass | null,
  suggestedAction: string
): TerraformAuditSummary {
  return {
    traceId: ctx.traceId,
    durationMs,
    retryCount: ctx.retryCount,
    errorClass,
    suggestedAction
  }
}

/**
 * Wrap an async function with audit instrumentation. Emits start/completed/failed
 * log events and returns the inner result unchanged on success. On failure, classifies
 * the error via `classifyCloudSdkError`, logs it, and re-throws the original error so
 * upstream callers see no behavior change.
 *
 * Attach the returned `TerraformAuditSummary` to the response shape when you want the
 * UI to render a trace id / suggested action.
 */
export async function withAudit<T>(
  ctx: TerraformAuditTraceContext,
  fn: () => Promise<T>,
  onSuccess?: (result: T, summary: TerraformAuditSummary) => T
): Promise<T> {
  logRunStarted(ctx)
  return auditStore.run(ctx, async () => {
    try {
      const result = await fn()
      const durationMs = Date.now() - ctx.startedAtMs
      logRunCompleted(ctx, durationMs)
      if (onSuccess) {
        const summary = buildAuditSummary(ctx, durationMs, null, '')
        return onSuccess(result, summary)
      }
      return result
    } catch (error) {
      const durationMs = Date.now() - ctx.startedAtMs
      const classified = classifyCloudSdkError(error, ctx.provider)
      logRunFailed(ctx, durationMs, classified.errorClass, classified.suggestedAction, error)
      throw error
    }
  })
}
