import { ipcMain } from 'electron'

import type {
  AwsCapabilitySubject,
  ComparisonBaselineInput,
  CloudWatchQueryFilter,
  CloudWatchQueryHistoryInput,
  CloudWatchSavedQueryInput,
  DirectAccessResolution,
  DbConnectionResolveInput,
  DbConnectionPresetFilter,
  DbConnectionPresetInput,
  DbVaultCredentialInput,
  EksUpgradePlannerRequest,
  AwsConnection,
  GovernanceTagDefaultsUpdate,
  VaultEntryFilter,
  VaultEntryInput,
  VaultEntryUsageInput
} from '@shared/types'
import { getAwsCapabilitySnapshot } from './aws/capabilities'
import {
  deleteComparisonBaseline,
  getComparisonBaseline,
  listComparisonBaselines,
  saveComparisonBaseline
} from './compareBaselineStore'
import { resolveDbConnectionMaterial } from './dbConnectionResolver'
import { resolveDirectAccessInput } from './directAccessGuidance'
import { buildEksUpgradePlan } from './eksUpgradePlanner'
import {
  deleteVaultEntryById,
  listVaultEntrySummaries,
  recordVaultEntryUse,
  revealVaultEntrySecret,
  saveVaultEntry,
  deleteDbVaultCredential,
  listDbVaultCredentials,
  setDbVaultCredential
} from './localVault'
import { createHandlerWrapper } from './operations'
import {
  clearCloudWatchQueryHistory,
  deleteCloudWatchSavedQuery,
  deleteDbConnectionPreset,
  getGovernanceTagDefaults,
  listCloudWatchQueryHistory,
  listCloudWatchSavedQueries,
  listDbConnectionPresets,
  markDbConnectionPresetUsed,
  recordCloudWatchQueryHistory,
  saveCloudWatchSavedQuery,
  saveDbConnectionPreset,
  updateGovernanceTagDefaults
} from './phase1FoundationStore'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('phase1-foundations', { timeoutMs: 30000 })

export function registerFoundationIpcHandlers(): void {
  ipcMain.handle('phase1:get-governance-tag-defaults', async () =>
    wrap(() => getGovernanceTagDefaults())
  )
  ipcMain.handle('phase1:update-governance-tag-defaults', async (_event, update: GovernanceTagDefaultsUpdate) =>
    wrap(() => updateGovernanceTagDefaults(update))
  )
  ipcMain.handle('phase1:list-cloudwatch-saved-queries', async (_event, filter?: CloudWatchQueryFilter) =>
    wrap(() => listCloudWatchSavedQueries(filter))
  )
  ipcMain.handle('phase1:save-cloudwatch-saved-query', async (_event, input: CloudWatchSavedQueryInput) =>
    wrap(() => saveCloudWatchSavedQuery(input))
  )
  ipcMain.handle('phase1:delete-cloudwatch-saved-query', async (_event, id: string) =>
    wrap(() => deleteCloudWatchSavedQuery(id))
  )
  ipcMain.handle('phase1:list-cloudwatch-query-history', async (_event, filter?: CloudWatchQueryFilter) =>
    wrap(() => listCloudWatchQueryHistory(filter))
  )
  ipcMain.handle('phase1:record-cloudwatch-query-history', async (_event, input: CloudWatchQueryHistoryInput) =>
    wrap(() => recordCloudWatchQueryHistory(input))
  )
  ipcMain.handle('phase1:clear-cloudwatch-query-history', async (_event, filter?: CloudWatchQueryFilter) =>
    wrap(() => clearCloudWatchQueryHistory(filter))
  )
  ipcMain.handle('phase1:list-db-connection-presets', async (_event, filter?: DbConnectionPresetFilter) =>
    wrap(() => listDbConnectionPresets(filter))
  )
  ipcMain.handle('phase1:save-db-connection-preset', async (_event, input: DbConnectionPresetInput) =>
    wrap(() => saveDbConnectionPreset(input))
  )
  ipcMain.handle('phase1:delete-db-connection-preset', async (_event, id: string) =>
    wrap(() => deleteDbConnectionPreset(id))
  )
  ipcMain.handle('phase1:mark-db-connection-preset-used', async (_event, id: string) =>
    wrap(() => markDbConnectionPresetUsed(id))
  )
  ipcMain.handle('phase1:list-db-vault-credentials', async () =>
    wrap(() => listDbVaultCredentials())
  )
  ipcMain.handle('phase1:save-db-vault-credential', async (_event, input: DbVaultCredentialInput) =>
    wrap(() => setDbVaultCredential(input))
  )
  ipcMain.handle('phase1:delete-db-vault-credential', async (_event, name: string) =>
    wrap(() => deleteDbVaultCredential(name))
  )
  ipcMain.handle('phase1:resolve-db-connection-material', async (_event, connection: AwsConnection, input: DbConnectionResolveInput) =>
    wrap(() => resolveDbConnectionMaterial(connection, input))
  )
  ipcMain.handle('phase1:get-aws-capability-snapshot', async (_event, region: string, subjects?: AwsCapabilitySubject[]) =>
    wrap(() => getAwsCapabilitySnapshot(region, subjects))
  )
  ipcMain.handle('phase2:list-vault-entries', async (_event, filter?: VaultEntryFilter) =>
    wrap(() => listVaultEntrySummaries(filter))
  )
  ipcMain.handle('phase2:save-vault-entry', async (_event, input: VaultEntryInput) =>
    wrap(() => saveVaultEntry(input))
  )
  ipcMain.handle('phase2:delete-vault-entry', async (_event, entryId: string) =>
    wrap(() => deleteVaultEntryById(entryId))
  )
  ipcMain.handle('phase2:reveal-vault-entry-secret', async (_event, entryId: string) =>
    wrap(() => revealVaultEntrySecret(entryId))
  )
  ipcMain.handle('phase2:record-vault-entry-use', async (_event, input: VaultEntryUsageInput) =>
    wrap(() => recordVaultEntryUse(input))
  )
  ipcMain.handle('phase2:list-comparison-baselines', async () =>
    wrap(() => listComparisonBaselines())
  )
  ipcMain.handle('phase2:get-comparison-baseline', async (_event, baselineId: string) =>
    wrap(() => getComparisonBaseline(baselineId))
  )
  ipcMain.handle('phase2:save-comparison-baseline', async (_event, input: ComparisonBaselineInput) =>
    wrap(() => saveComparisonBaseline(input))
  )
  ipcMain.handle('phase2:delete-comparison-baseline', async (_event, baselineId: string) =>
    wrap(() => deleteComparisonBaseline(baselineId))
  )
  ipcMain.handle('phase2:build-eks-upgrade-plan', async (_event, connection: AwsConnection, request: EksUpgradePlannerRequest) =>
    wrap(() => buildEksUpgradePlan(connection, request))
  )
  ipcMain.handle('phase2:resolve-direct-access-input', async (_event, input: string): Promise<HandlerResult<DirectAccessResolution>> =>
    wrap(() => resolveDirectAccessInput(input))
  )
}
