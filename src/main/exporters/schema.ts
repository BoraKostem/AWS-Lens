import type {
  EnterpriseAuditEvent,
  ExportEventKind,
  ExporterRedactionMode,
  TerraformDriftSnapshot,
  TerraformRunRecord
} from '@shared/types'

export type NormalizedExportDocument = {
  _id: string
  _kind: ExportEventKind
  _schemaVersion: 1
  timestamp: string
  [key: string]: unknown
}

const SECRET_PATTERN = /password|secret|token|key|api_key|private|credentials?/i
const SECRET_VALUE_PATTERN = /^(eyJ|ghp_|glpat-|sk-|xox[baprs]-)/

function redactValue(key: string, value: string, mode: ExporterRedactionMode): string {
  if (mode === 'none') return value
  if (SECRET_PATTERN.test(key)) return '***'
  if (mode === 'full' && SECRET_VALUE_PATTERN.test(value)) return '***'
  return value
}

function redactStringArray(arr: string[], mode: ExporterRedactionMode): string[] {
  return arr.map((item) => {
    const eqIdx = item.indexOf('=')
    if (eqIdx === -1) return item
    const k = item.slice(0, eqIdx)
    const v = item.slice(eqIdx + 1)
    return `${k}=${redactValue(k, v, mode)}`
  })
}

export function auditEventToDocument(
  event: EnterpriseAuditEvent,
  mode: ExporterRedactionMode,
  teamLabel: string,
  projectLabel: string
): NormalizedExportDocument {
  return {
    _id: event.id,
    _kind: 'audit',
    _schemaVersion: 1,
    timestamp: event.happenedAt,
    kind: 'audit',
    outcome: event.outcome,
    accessMode: event.accessMode,
    providerId: event.providerId ?? '',
    action: event.action,
    channel: event.channel,
    summary: event.summary,
    actorLabel: event.actorLabel,
    accountId: mode === 'full' ? '***' : event.accountId,
    region: event.region,
    serviceId: event.serviceId,
    resourceId: event.resourceId,
    details: redactStringArray(event.details, mode),
    teamLabel,
    projectLabel
  }
}

export function driftSnapshotToDocument(
  projectId: string,
  projectName: string,
  snapshot: TerraformDriftSnapshot,
  _mode: ExporterRedactionMode,
  teamLabel: string,
  projectLabel: string
): NormalizedExportDocument {
  return {
    _id: snapshot.id,
    _kind: 'drift-snapshot',
    _schemaVersion: 1,
    timestamp: snapshot.scannedAt,
    kind: 'drift-snapshot',
    projectId,
    projectName,
    trigger: snapshot.trigger,
    summary: snapshot.summary,
    itemCount: snapshot.items.length,
    // Items are kept lean to avoid bloating the ES index — full item detail is
    // available in the local snapshot store if an operator wants to correlate.
    itemPreview: snapshot.items.slice(0, 50).map((item) => ({
      id: (item as { id?: string }).id ?? '',
      status: (item as { status?: string }).status ?? '',
      resourceType: (item as { resourceType?: string }).resourceType ?? ''
    })),
    teamLabel,
    projectLabel
  }
}

export function runRecordToDocument(
  record: TerraformRunRecord,
  mode: ExporterRedactionMode,
  teamLabel: string,
  projectLabel: string
): NormalizedExportDocument {
  return {
    _id: record.id,
    _kind: 'terraform-run',
    _schemaVersion: 1,
    timestamp: record.startedAt,
    kind: 'terraform-run',
    projectId: record.projectId,
    projectName: record.projectName,
    command: record.command,
    args: redactStringArray(record.args, mode),
    workspace: record.workspace,
    region: record.region,
    connectionLabel: record.connectionLabel,
    backendType: record.backendType,
    stateSource: record.stateSource,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    exitCode: record.exitCode,
    success: record.success,
    durationMs: record.durationMs ?? null,
    errorClass: record.errorClass ?? null,
    suggestedAction: record.suggestedAction ?? '',
    retryCount: record.retryCount ?? 0,
    provider: record.provider ?? 'local',
    module: record.module ?? '',
    resource: record.resource ?? '',
    stackRoot: record.stackRoot ?? '',
    unitPath: record.unitPath ?? '',
    dependencyPhase: record.dependencyPhase ?? null,
    planSummary: record.planSummary ?? null,
    git: record.git ?? null,
    teamLabel,
    projectLabel
  }
}
