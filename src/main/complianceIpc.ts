import { ipcMain } from 'electron'

import type { AwsConnection, ComplianceFindingWorkflowUpdate } from '@shared/types'
import { getComplianceReport } from './aws/compliance'
import { createHandlerWrapper } from './operations'
import { updateComplianceFindingWorkflow } from './phase1FoundationStore'

type HandlerResult<T> = { ok: true; data: T } | { ok: false; error: string }
const wrap: <T>(fn: () => Promise<T> | T, label?: string) => Promise<HandlerResult<T>> =
  createHandlerWrapper('compliance-ipc', { timeoutMs: 60000 })

export function registerComplianceIpcHandlers(): void {
  ipcMain.handle('compliance:report', async (_event, connection: AwsConnection) =>
    wrap(() => getComplianceReport(connection))
  )
  ipcMain.handle(
    'compliance:update-finding-workflow',
    async (_event, connection: AwsConnection, findingId: string, update: ComplianceFindingWorkflowUpdate) =>
      wrap(() => updateComplianceFindingWorkflow(
        connection.kind === 'assumed-role'
          ? [connection.sourceProfile, connection.roleArn, connection.accountId, connection.region].join('::')
          : [connection.profile, connection.region].join('::'),
        findingId,
        update
      ))
  )
}
