import { ipcMain } from 'electron'
import type { ExporterConfig, TerraformRunRecord } from '@shared/types'
import {
  applyExporterConfig,
  getExporterConfig,
  getExporterHealth,
  pingElasticsearch,
  purgeQueue,
  queryTeamTimelineWrapper,
  sendTestEvent
} from '../exporters'
import type { TeamTimelineFilter } from '../exporters/elasticsearch'
import { listRunRecords } from '../terraformHistoryStore'
import { wrap } from './shared'

type MergedTimelineEntry = {
  source: 'local' | 'remote'
  timestamp: string
  kind: 'audit' | 'terraform-run'
  payload: unknown
}

export function registerExportersHandlers(): void {
  ipcMain.handle('exporters:get-config', () =>
    wrap(() => getExporterConfig())
  )

  ipcMain.handle('exporters:set-config', async (_event, config: ExporterConfig) =>
    wrap(async () => {
      await applyExporterConfig(config)
      return getExporterConfig()
    })
  )

  ipcMain.handle('exporters:get-health', () =>
    wrap(() => getExporterHealth())
  )

  ipcMain.handle('exporters:purge-queue', () =>
    wrap(() => {
      purgeQueue()
      return true
    })
  )

  ipcMain.handle('exporters:ping-elasticsearch', (_event, config: ExporterConfig['elasticsearch']) =>
    wrap(() => pingElasticsearch(config))
  )

  ipcMain.handle('exporters:send-test-event', () =>
    wrap(() => {
      sendTestEvent()
      return true
    })
  )

  // Activity aggregation: merge local run history with remote ES hits for
  // a team-visible timeline. De-duplicates by run id so a run that shipped to
  // ES from this machine is not shown twice.
  ipcMain.handle('exporters:query-team-timeline', async (_event, filter: TeamTimelineFilter) =>
    wrap(async () => {
      const remote = await queryTeamTimelineWrapper(filter)
      const local = listRunRecords()

      const seenIds = new Set<string>()
      const merged: MergedTimelineEntry[] = []

      for (const hit of remote.hits) {
        const h = hit as { _id?: string; timestamp?: string; _kind?: 'audit' | 'terraform-run' }
        if (h._id) seenIds.add(h._id)
        merged.push({
          source: 'remote',
          timestamp: h.timestamp ?? '',
          kind: h._kind ?? 'terraform-run',
          payload: hit
        })
      }

      for (const record of local) {
        if (seenIds.has(record.id)) continue
        merged.push({
          source: 'local',
          timestamp: record.startedAt,
          kind: 'terraform-run',
          payload: record as TerraformRunRecord
        })
      }

      merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      return {
        entries: merged,
        remoteOk: remote.ok,
        remoteError: remote.error
      }
    })
  )
}
