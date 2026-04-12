/**
 * GCP Billing & Cost Analysis — extends the existing billing surface in gcpSdk.ts
 * with historical cost trends, cost-by-label breakdowns, daily burn-rate,
 * SKU-level drill-down, budgets, forecasting, and anomaly detection.
 *
 * All BigQuery-based queries require a Cloud Billing export table.
 * Discovery and schema validation mirror the patterns in gcpSdk.ts.
 *
 * Depends on: gcp/client.ts (requestGcp, paginationGuard, classifyGcpError)
 */

import { classifyGcpError, paginationGuard, requestGcp } from './client'
import type {
  GcpBillingAccountSummary,
  GcpBillingCostTrend,
  GcpBillingCostTrendMonth,
  GcpBillingDailyCostTrend,
  GcpBillingDailyCostEntry,
  GcpBillingCostByLabel,
  GcpBillingLabelCostEntry,
  GcpBillingSkuBreakdown,
  GcpBillingSkuCostEntry,
  GcpBillingBudgetSummary,
  GcpBillingCostForecast,
  GcpBillingCostAnomaly
} from '@shared/types'

// ── Helpers ─────────────────────────────────────────────────────────────────────

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asBoolean(value: unknown): boolean {
  return value === true || value === 'true'
}

function normalizeNumber(value: unknown): number {
  if (typeof value === 'number') return value
  const parsed = parseFloat(String(value ?? ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function toRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const BILLING_API = 'cloudbilling.googleapis.com'
const BUDGET_API = 'billingbudgets.googleapis.com'
const BQ_API = 'bigquery.googleapis.com'

// ── BigQuery Infrastructure ─────────────────────────────────────────────────────
// Lightweight versions of the BigQuery helpers from gcpSdk.ts so the billing
// module can run queries without exporting private gcpSdk internals.

function buildBqUrl(pathname: string, query: Record<string, string | number | undefined> = {}): string {
  const url = new URL(`https://bigquery.googleapis.com/bigquery/v2/${pathname.replace(/^\/+/, '')}`)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url.toString()
}

type BqSchemaField = { name: string; fields: BqSchemaField[] }
type BqExportTable = { projectId: string; datasetId: string; tableId: string; location: string; priority: number }

function scoreBillingTable(tableId: string): number {
  const t = tableId.toLowerCase()
  if (t.startsWith('gcp_billing_export_resource_v1_')) return 4
  if (t.startsWith('gcp_billing_export_v1_')) return 3
  if (t.startsWith('gcp_billing_export_')) return 2
  return t.includes('gcp_billing_export') ? 1 : 0
}

function parseBqSchemaField(value: unknown): BqSchemaField | null {
  const r = toRecord(value)
  const name = asString(r.name)
  if (!name) return null
  return { name, fields: (Array.isArray(r.fields) ? r.fields : []).map(parseBqSchemaField).filter((f): f is BqSchemaField => f !== null) }
}

function findField(fields: BqSchemaField[], name: string): BqSchemaField | null {
  return fields.find((f) => f.name.toLowerCase() === name.toLowerCase()) ?? null
}

function hasNested(fields: BqSchemaField[], parent: string, child: string): boolean {
  const p = findField(fields, parent)
  return Boolean(p && findField(p.fields, child))
}

async function discoverExportTable(projectId: string, candidateProjectIds: string[]): Promise<BqExportTable | null> {
  const candidates: BqExportTable[] = []
  const uniqueIds = [...new Set(candidateProjectIds.filter(Boolean))]
  const canPage = paginationGuard()

  for (const pid of uniqueIds) {
    try {
      // List datasets
      const datasets: { pid: string; dsId: string; loc: string }[] = []
      let dsToken = ''
      do {
        const dsResp = await requestGcp<Record<string, unknown>>(pid, {
          url: buildBqUrl(`projects/${encodeURIComponent(pid)}/datasets`, { all: 'true', maxResults: 500, pageToken: dsToken || undefined })
        })
        for (const entry of (Array.isArray(dsResp.datasets) ? dsResp.datasets : []) as Array<Record<string, unknown>>) {
          const ref = toRecord(entry.datasetReference)
          const dsId = asString(ref.datasetId)
          if (dsId) datasets.push({ pid: asString(ref.projectId) || pid, dsId, loc: asString(entry.location) })
        }
        dsToken = asString(dsResp.nextPageToken)
      } while (dsToken && canPage())

      // List tables per dataset
      for (const ds of datasets) {
        try {
          let tblToken = ''
          do {
            const tblResp = await requestGcp<Record<string, unknown>>(ds.pid, {
              url: buildBqUrl(`projects/${encodeURIComponent(ds.pid)}/datasets/${encodeURIComponent(ds.dsId)}/tables`, { maxResults: 500, pageToken: tblToken || undefined })
            })
            for (const entry of (Array.isArray(tblResp.tables) ? tblResp.tables : []) as Array<Record<string, unknown>>) {
              const ref = toRecord(entry.tableReference)
              const tableId = asString(ref.tableId)
              const priority = scoreBillingTable(tableId)
              if (tableId && priority > 0) {
                candidates.push({ projectId: ds.pid, datasetId: ds.dsId, tableId, location: ds.loc, priority })
              }
            }
            tblToken = asString(tblResp.nextPageToken)
          } while (tblToken && canPage())
        } catch { /* skip inaccessible dataset */ }
      }
    } catch { /* skip inaccessible project */ }
  }

  return candidates.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    if (a.projectId === projectId && b.projectId !== projectId) return -1
    if (b.projectId === projectId && a.projectId !== projectId) return 1
    return `${a.projectId}.${a.datasetId}`.localeCompare(`${b.projectId}.${b.datasetId}`)
  })[0] ?? null
}

async function getTableSchema(table: BqExportTable): Promise<BqSchemaField[]> {
  const resp = await requestGcp<Record<string, unknown>>(table.projectId, {
    url: buildBqUrl(`projects/${encodeURIComponent(table.projectId)}/datasets/${encodeURIComponent(table.datasetId)}/tables/${encodeURIComponent(table.tableId)}`)
  })
  const schema = toRecord(resp.schema)
  return (Array.isArray(schema.fields) ? schema.fields : []).map(parseBqSchemaField).filter((f): f is BqSchemaField => f !== null)
}

async function runBqQuery(
  authProjectId: string,
  location: string,
  query: string,
  params: Array<{ name: string; type: 'STRING' | 'TIMESTAMP'; value: string }>
): Promise<Array<Array<string>>> {
  const initial = await requestGcp<Record<string, unknown>>(authProjectId, {
    url: buildBqUrl(`projects/${encodeURIComponent(authProjectId)}/queries`),
    method: 'POST',
    data: {
      query,
      useLegacySql: false,
      timeoutMs: 25000,
      location: location || undefined,
      parameterMode: 'NAMED',
      queryParameters: params.map((p) => ({
        name: p.name,
        parameterType: { type: p.type },
        parameterValue: { value: p.value }
      }))
    }
  })

  let response = initial
  let attempts = 0
  const jobRef = toRecord(initial.jobReference)
  const jobId = asString(jobRef.jobId)

  while (!asBoolean(response.jobComplete) && jobId && attempts < 15) {
    attempts += 1
    await new Promise((r) => setTimeout(r, 500))
    response = await requestGcp<Record<string, unknown>>(authProjectId, {
      url: buildBqUrl(`projects/${encodeURIComponent(authProjectId)}/queries/${encodeURIComponent(jobId)}`, {
        location: location || undefined,
        maxResults: 200
      })
    })
  }

  // Parse result rows into string arrays
  const rows = Array.isArray(response.rows) ? response.rows as Array<Record<string, unknown>> : []
  return rows.map((row) => {
    const fields = Array.isArray(row.f) ? row.f as Array<Record<string, unknown>> : []
    return fields.map((f) => asString(f.v))
  })
}

// ── Schema-Aware Expression Builders ────────────────────────────────────────────

function serviceExpr(fields: BqSchemaField[]): string {
  if (hasNested(fields, 'service', 'description')) return 'COALESCE(service.description, "Other")'
  if (findField(fields, 'service_description')) return 'COALESCE(service_description, "Other")'
  return '"Other"'
}

function projectIdExpr(fields: BqSchemaField[]): string {
  if (hasNested(fields, 'project', 'id')) return 'project.id'
  if (hasNested(fields, 'project', 'project_id')) return 'project.project_id'
  if (findField(fields, 'project_id')) return 'project_id'
  return ''
}

function usageTimeExpr(fields: BqSchemaField[]): string {
  if (findField(fields, 'usage_start_time')) return 'usage_start_time'
  if (findField(fields, 'usage_end_time')) return 'usage_end_time'
  return ''
}

function costExpr(fields: BqSchemaField[]): string {
  if (findField(fields, 'credits')) {
    return 'CAST(cost AS FLOAT64) + IFNULL((SELECT SUM(CAST(c.amount AS FLOAT64)) FROM UNNEST(credits) AS c), 0)'
  }
  return 'CAST(cost AS FLOAT64)'
}

function skuExpr(fields: BqSchemaField[]): string {
  if (hasNested(fields, 'sku', 'description')) return 'COALESCE(sku.description, "Unknown")'
  if (findField(fields, 'sku_description')) return 'COALESCE(sku_description, "Unknown")'
  return '"Unknown"'
}

function labelExpr(fields: BqSchemaField[], labelKey: string): string {
  if (findField(fields, 'labels')) {
    return `COALESCE((SELECT value FROM UNNEST(labels) WHERE key = @labelKey), "(untagged)")`
  }
  if (hasNested(fields, 'project', 'labels')) {
    return `COALESCE((SELECT value FROM UNNEST(project.labels) WHERE key = @labelKey), "(untagged)")`
  }
  return '"(untagged)"'
}

function validateSchema(fields: BqSchemaField[], table: BqExportTable): void {
  if (!projectIdExpr(fields) || !usageTimeExpr(fields) || !findField(fields, 'cost')) {
    throw new Error(`Billing export table "${table.projectId}.${table.datasetId}.${table.tableId}" uses an unsupported schema.`)
  }
}

// ── Billing Account List ────────────────────────────────────────────────────────

/**
 * Lists all billing accounts accessible to the current credentials.
 * Requires: billing.accounts.list — API: cloudbilling.googleapis.com
 */
export async function listGcpBillingAccounts(
  projectId: string
): Promise<GcpBillingAccountSummary[]> {
  const pid = projectId.trim()
  if (!pid) return []

  try {
    const accounts: GcpBillingAccountSummary[] = []
    let pageToken = ''
    const canPage = paginationGuard()

    do {
      const response = await requestGcp<{
        billingAccounts?: Array<Record<string, unknown>>
        nextPageToken?: string
      }>(pid, {
        url: `https://cloudbilling.googleapis.com/v1/billingAccounts?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      })

      for (const entry of response.billingAccounts ?? []) {
        accounts.push({
          name: asString(entry.name),
          displayName: asString(entry.displayName),
          open: asBoolean(entry.open),
          masterBillingAccount: asString(entry.masterBillingAccount)
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return accounts.sort((a, b) => a.displayName.localeCompare(b.displayName))
  } catch (error) {
    throw classifyGcpError(`listing billing accounts`, error, BILLING_API)
  }
}

// ── Monthly Cost Trend ──────────────────────────────────────────────────────────

/**
 * Returns month-over-month cost totals and service breakdown for N months.
 * Uses BigQuery billing export. Requires: bigquery.jobs.create
 */
export async function getGcpCostTrend(
  projectId: string,
  months = 6,
  catalogProjectIds: string[] = []
): Promise<GcpBillingCostTrend> {
  const pid = projectId.trim()
  if (!pid) {
    return { projectId: '', months: [], currency: '', message: 'No project selected.' }
  }

  try {
    const table = await discoverExportTable(pid, [pid, ...catalogProjectIds])
    if (!table) {
      return { projectId: pid, months: [], currency: '', message: 'No BigQuery billing export table was discovered.' }
    }

    const fields = await getTableSchema(table)
    validateSchema(fields, table)

    const now = new Date()
    const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1))
    const pId = projectIdExpr(fields)
    const uTime = usageTimeExpr(fields)
    const cost = costExpr(fields)
    const svc = serviceExpr(fields)

    const query = `
      SELECT
        FORMAT_TIMESTAMP('%Y-%m', ${uTime}) AS month,
        ${svc} AS service,
        ROUND(SUM(${cost}), 2) AS amount,
        COALESCE(ANY_VALUE(currency), '') AS currency
      FROM \`${table.projectId}.${table.datasetId}.${table.tableId}\`
      WHERE ${uTime} >= TIMESTAMP(@startDate)
        AND ${pId} = @projectId
      GROUP BY month, service
      HAVING ABS(SUM(${cost})) > 0.009
      ORDER BY month DESC, amount DESC
    `.trim()

    const rows = await runBqQuery(table.projectId, table.location, query, [
      { name: 'startDate', type: 'TIMESTAMP', value: startDate.toISOString() },
      { name: 'projectId', type: 'STRING', value: pid }
    ])

    // Aggregate into monthly buckets
    const monthMap = new Map<string, { total: number; currency: string; services: Map<string, number> }>()
    for (const [month, service, amountStr, currency] of rows) {
      const amount = normalizeNumber(amountStr)
      if (!monthMap.has(month)) monthMap.set(month, { total: 0, currency: '', services: new Map() })
      const bucket = monthMap.get(month)!
      bucket.total += amount
      if (currency) bucket.currency = currency
      bucket.services.set(service, (bucket.services.get(service) ?? 0) + amount)
    }

    const currency = [...monthMap.values()].find((b) => b.currency)?.currency ?? ''
    const monthEntries: GcpBillingCostTrendMonth[] = [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({
        month,
        totalAmount: Math.round(bucket.total * 100) / 100,
        currency: bucket.currency || currency,
        topServices: [...bucket.services.entries()]
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([service, amount]) => ({ service, amount: Math.round(amount * 100) / 100 }))
      }))

    return {
      projectId: pid,
      months: monthEntries,
      currency,
      message: `Cost trend sourced from ${table.projectId}.${table.datasetId}.${table.tableId}.`
    }
  } catch (error) {
    throw classifyGcpError(`loading cost trend for project "${pid}"`, error, BQ_API)
  }
}

// ── Daily Cost Trend ────────────────────────────────────────────────────────────

/**
 * Returns daily cost totals for the past N days. Useful for burn-rate charts.
 */
export async function getGcpDailyCostTrend(
  projectId: string,
  days = 30,
  catalogProjectIds: string[] = []
): Promise<GcpBillingDailyCostTrend> {
  const pid = projectId.trim()
  if (!pid) {
    return { projectId: '', days: [], currency: '', message: 'No project selected.' }
  }

  try {
    const table = await discoverExportTable(pid, [pid, ...catalogProjectIds])
    if (!table) {
      return { projectId: pid, days: [], currency: '', message: 'No BigQuery billing export table was discovered.' }
    }

    const fields = await getTableSchema(table)
    validateSchema(fields, table)

    const startDate = new Date(Date.now() - days * 86_400_000)
    const pId = projectIdExpr(fields)
    const uTime = usageTimeExpr(fields)
    const cost = costExpr(fields)

    const query = `
      SELECT
        FORMAT_TIMESTAMP('%Y-%m-%d', ${uTime}) AS day,
        ROUND(SUM(${cost}), 2) AS amount,
        COALESCE(ANY_VALUE(currency), '') AS currency
      FROM \`${table.projectId}.${table.datasetId}.${table.tableId}\`
      WHERE ${uTime} >= TIMESTAMP(@startDate)
        AND ${pId} = @projectId
      GROUP BY day
      ORDER BY day ASC
    `.trim()

    const rows = await runBqQuery(table.projectId, table.location, query, [
      { name: 'startDate', type: 'TIMESTAMP', value: startDate.toISOString() },
      { name: 'projectId', type: 'STRING', value: pid }
    ])

    const currency = rows.find((r) => r[2])?.[ 2] ?? ''
    const dayEntries: GcpBillingDailyCostEntry[] = rows.map(([day, amountStr, cur]) => ({
      date: day,
      amount: normalizeNumber(amountStr),
      currency: cur || currency
    }))

    return {
      projectId: pid,
      days: dayEntries,
      currency,
      message: `Daily cost trend sourced from ${table.projectId}.${table.datasetId}.${table.tableId}.`
    }
  } catch (error) {
    throw classifyGcpError(`loading daily cost trend for project "${pid}"`, error, BQ_API)
  }
}

// ── Cost By Label ───────────────────────────────────────────────────────────────

/**
 * Breaks down current-month cost by label key values. Useful for team/environment
 * cost allocation dashboards.
 */
export async function getGcpCostByLabel(
  projectId: string,
  labelKey: string,
  catalogProjectIds: string[] = []
): Promise<GcpBillingCostByLabel> {
  const pid = projectId.trim()
  const normalizedKey = labelKey.trim()
  if (!pid || !normalizedKey) {
    return { projectId: '', labelKey: '', entries: [], totalAmount: 0, currency: '', message: 'Missing project or label key.' }
  }

  try {
    const table = await discoverExportTable(pid, [pid, ...catalogProjectIds])
    if (!table) {
      return { projectId: pid, labelKey: normalizedKey, entries: [], totalAmount: 0, currency: '', message: 'No BigQuery billing export table was discovered.' }
    }

    const fields = await getTableSchema(table)
    validateSchema(fields, table)

    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const pId = projectIdExpr(fields)
    const uTime = usageTimeExpr(fields)
    const cost = costExpr(fields)
    const lbl = labelExpr(fields, normalizedKey)

    const query = `
      SELECT
        ${lbl} AS label_value,
        ROUND(SUM(${cost}), 2) AS amount,
        COALESCE(ANY_VALUE(currency), '') AS currency
      FROM \`${table.projectId}.${table.datasetId}.${table.tableId}\`
      WHERE ${uTime} >= TIMESTAMP(@monthStart)
        AND ${uTime} < TIMESTAMP(@monthEnd)
        AND ${pId} = @projectId
      GROUP BY label_value
      HAVING ABS(SUM(${cost})) > 0.009
      ORDER BY amount DESC
      LIMIT 50
    `.trim()

    const rows = await runBqQuery(table.projectId, table.location, query, [
      { name: 'monthStart', type: 'TIMESTAMP', value: monthStart.toISOString() },
      { name: 'monthEnd', type: 'TIMESTAMP', value: now.toISOString() },
      { name: 'projectId', type: 'STRING', value: pid },
      { name: 'labelKey', type: 'STRING', value: normalizedKey }
    ])

    const currency = rows.find((r) => r[2])?.[ 2] ?? ''
    const totalAmount = rows.reduce((sum, r) => sum + normalizeNumber(r[1]), 0)
    const entries: GcpBillingLabelCostEntry[] = rows.map(([value, amountStr, cur]) => ({
      labelValue: value || '(untagged)',
      amount: normalizeNumber(amountStr),
      currency: cur || currency,
      sharePercent: totalAmount > 0 ? (normalizeNumber(amountStr) / totalAmount) * 100 : 0
    }))

    return {
      projectId: pid,
      labelKey: normalizedKey,
      entries,
      totalAmount: Math.round(totalAmount * 100) / 100,
      currency,
      message: `Label cost breakdown sourced from ${table.projectId}.${table.datasetId}.${table.tableId}.`
    }
  } catch (error) {
    throw classifyGcpError(`loading cost by label "${normalizedKey}" for project "${pid}"`, error, BQ_API)
  }
}

// ── SKU-Level Cost Breakdown ────────────────────────────────────────────────────

/**
 * Drill-down into a specific service's SKU-level costs for the current month.
 */
export async function getGcpSkuCostBreakdown(
  projectId: string,
  serviceName: string,
  catalogProjectIds: string[] = []
): Promise<GcpBillingSkuBreakdown> {
  const pid = projectId.trim()
  const svcFilter = serviceName.trim()
  if (!pid || !svcFilter) {
    return { projectId: '', serviceName: '', entries: [], totalAmount: 0, currency: '', message: 'Missing project or service name.' }
  }

  try {
    const table = await discoverExportTable(pid, [pid, ...catalogProjectIds])
    if (!table) {
      return { projectId: pid, serviceName: svcFilter, entries: [], totalAmount: 0, currency: '', message: 'No BigQuery billing export table was discovered.' }
    }

    const fields = await getTableSchema(table)
    validateSchema(fields, table)

    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const pId = projectIdExpr(fields)
    const uTime = usageTimeExpr(fields)
    const cost = costExpr(fields)
    const svc = serviceExpr(fields)
    const sku = skuExpr(fields)

    const query = `
      SELECT
        ${sku} AS sku_description,
        ROUND(SUM(${cost}), 2) AS amount,
        COALESCE(ANY_VALUE(currency), '') AS currency
      FROM \`${table.projectId}.${table.datasetId}.${table.tableId}\`
      WHERE ${uTime} >= TIMESTAMP(@monthStart)
        AND ${uTime} < TIMESTAMP(@monthEnd)
        AND ${pId} = @projectId
        AND ${svc} = @serviceName
      GROUP BY sku_description
      HAVING ABS(SUM(${cost})) > 0.001
      ORDER BY amount DESC
      LIMIT 30
    `.trim()

    const rows = await runBqQuery(table.projectId, table.location, query, [
      { name: 'monthStart', type: 'TIMESTAMP', value: monthStart.toISOString() },
      { name: 'monthEnd', type: 'TIMESTAMP', value: now.toISOString() },
      { name: 'projectId', type: 'STRING', value: pid },
      { name: 'serviceName', type: 'STRING', value: svcFilter }
    ])

    const currency = rows.find((r) => r[2])?.[ 2] ?? ''
    const totalAmount = rows.reduce((sum, r) => sum + normalizeNumber(r[1]), 0)
    const entries: GcpBillingSkuCostEntry[] = rows.map(([skuDesc, amountStr, cur]) => ({
      skuDescription: skuDesc || 'Unknown',
      amount: normalizeNumber(amountStr),
      currency: cur || currency,
      sharePercent: totalAmount > 0 ? (normalizeNumber(amountStr) / totalAmount) * 100 : 0
    }))

    return {
      projectId: pid,
      serviceName: svcFilter,
      entries,
      totalAmount: Math.round(totalAmount * 100) / 100,
      currency,
      message: `SKU breakdown sourced from ${table.projectId}.${table.datasetId}.${table.tableId}.`
    }
  } catch (error) {
    throw classifyGcpError(`loading SKU breakdown for service "${svcFilter}" in project "${pid}"`, error, BQ_API)
  }
}

// ── Billing Budgets ─────────────────────────────────────────────────────────────

/**
 * Lists billing budgets for a given billing account. Requires:
 * billingbudgets.budgets.list — API: billingbudgets.googleapis.com
 */
export async function listGcpBillingBudgets(
  projectId: string,
  billingAccountName: string
): Promise<GcpBillingBudgetSummary[]> {
  const pid = projectId.trim()
  const account = billingAccountName.trim().replace(/^billingAccounts\//, '')
  if (!pid || !account) return []

  try {
    const budgets: GcpBillingBudgetSummary[] = []
    let pageToken = ''
    const canPage = paginationGuard(5)

    do {
      const response = await requestGcp<{
        budgets?: Array<Record<string, unknown>>
        nextPageToken?: string
      }>(pid, {
        url: `https://billingbudgets.googleapis.com/v1/billingAccounts/${encodeURIComponent(account)}/budgets?pageSize=50${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
      })

      for (const entry of response.budgets ?? []) {
        const amount = toRecord(entry.amount)
        const specifiedAmount = toRecord(amount.specifiedAmount)
        const budgetFilter = toRecord(entry.budgetFilter)
        const thresholdRules = Array.isArray(entry.thresholdRules)
          ? (entry.thresholdRules as Array<Record<string, unknown>>)
          : []

        // Parse project scope
        const projects = Array.isArray(budgetFilter.projects)
          ? (budgetFilter.projects as unknown[]).map((p) => asString(p)).filter(Boolean)
          : []

        budgets.push({
          name: asString(entry.name),
          displayName: asString(entry.displayName) || 'Unnamed Budget',
          budgetAmount: normalizeNumber(specifiedAmount.units) + normalizeNumber(specifiedAmount.nanos) / 1_000_000_000,
          currency: asString(specifiedAmount.currencyCode),
          scopeProjectIds: projects.map((p) => p.replace(/^projects\//, '')),
          thresholdPercents: thresholdRules.map((r) => normalizeNumber(r.thresholdPercent) * 100).sort((a, b) => a - b),
          calendarPeriod: asString(budgetFilter.calendarPeriod) || asString(entry.calendarPeriod) || 'MONTH'
        })
      }

      pageToken = asString(response.nextPageToken)
    } while (pageToken && canPage())

    return budgets.sort((a, b) => a.displayName.localeCompare(b.displayName))
  } catch (error) {
    // Budgets API may not be enabled — graceful fallback
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.toLowerCase().includes('disabled') || detail.toLowerCase().includes('not been used')) {
      return []
    }
    throw classifyGcpError(`listing budgets for billing account "${account}"`, error, BUDGET_API)
  }
}

// ── Cost Forecast ───────────────────────────────────────────────────────────────

/**
 * Projects end-of-month cost based on current burn rate. Uses daily cost data
 * to compute average daily spend and extrapolate to full month.
 */
export async function getGcpCostForecast(
  projectId: string,
  catalogProjectIds: string[] = []
): Promise<GcpBillingCostForecast> {
  const pid = projectId.trim()
  if (!pid) {
    return { projectId: '', currentMonthSpend: 0, forecastedMonthEnd: 0, averageDailySpend: 0, daysElapsed: 0, daysRemaining: 0, currency: '', confidence: 'low', message: 'No project selected.' }
  }

  try {
    const table = await discoverExportTable(pid, [pid, ...catalogProjectIds])
    if (!table) {
      return { projectId: pid, currentMonthSpend: 0, forecastedMonthEnd: 0, averageDailySpend: 0, daysElapsed: 0, daysRemaining: 0, currency: '', confidence: 'low', message: 'No BigQuery billing export table was discovered.' }
    }

    const fields = await getTableSchema(table)
    validateSchema(fields, table)

    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate()
    const daysElapsed = Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000))
    const daysRemaining = Math.max(0, daysInMonth - daysElapsed)

    const pId = projectIdExpr(fields)
    const uTime = usageTimeExpr(fields)
    const cost = costExpr(fields)

    const query = `
      SELECT
        ROUND(SUM(${cost}), 2) AS total,
        COALESCE(ANY_VALUE(currency), '') AS currency
      FROM \`${table.projectId}.${table.datasetId}.${table.tableId}\`
      WHERE ${uTime} >= TIMESTAMP(@monthStart)
        AND ${uTime} < TIMESTAMP(@monthEnd)
        AND ${pId} = @projectId
    `.trim()

    const rows = await runBqQuery(table.projectId, table.location, query, [
      { name: 'monthStart', type: 'TIMESTAMP', value: monthStart.toISOString() },
      { name: 'monthEnd', type: 'TIMESTAMP', value: now.toISOString() },
      { name: 'projectId', type: 'STRING', value: pid }
    ])

    const currentMonthSpend = rows.length > 0 ? normalizeNumber(rows[0][0]) : 0
    const currency = rows.length > 0 ? (rows[0][1] || '') : ''
    const averageDailySpend = daysElapsed > 0 ? currentMonthSpend / daysElapsed : 0
    const forecastedMonthEnd = currentMonthSpend + (averageDailySpend * daysRemaining)

    // Confidence based on how many days of data we have
    let confidence: GcpBillingCostForecast['confidence'] = 'low'
    if (daysElapsed >= 14) confidence = 'high'
    else if (daysElapsed >= 7) confidence = 'medium'

    return {
      projectId: pid,
      currentMonthSpend: Math.round(currentMonthSpend * 100) / 100,
      forecastedMonthEnd: Math.round(forecastedMonthEnd * 100) / 100,
      averageDailySpend: Math.round(averageDailySpend * 100) / 100,
      daysElapsed,
      daysRemaining,
      currency,
      confidence,
      message: `Forecast based on ${daysElapsed} days of data from ${table.projectId}.${table.datasetId}.${table.tableId}.`
    }
  } catch (error) {
    throw classifyGcpError(`computing cost forecast for project "${pid}"`, error, BQ_API)
  }
}

// ── Cost Anomaly Detection ──────────────────────────────────────────────────────

/**
 * Compares current-month service costs against the previous month to detect
 * anomalies (significant increases). Returns services with >25% and >$5 increase.
 */
export async function getGcpCostAnomalies(
  projectId: string,
  catalogProjectIds: string[] = []
): Promise<GcpBillingCostAnomaly[]> {
  const pid = projectId.trim()
  if (!pid) return []

  try {
    const table = await discoverExportTable(pid, [pid, ...catalogProjectIds])
    if (!table) return []

    const fields = await getTableSchema(table)
    validateSchema(fields, table)

    const now = new Date()
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const previousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const previousMonthEnd = currentMonthStart

    // Calculate proportional comparison: normalize previous month to same number of days elapsed
    const daysElapsed = Math.max(1, Math.ceil((now.getTime() - currentMonthStart.getTime()) / 86_400_000))
    const prevMonthDays = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)).getUTCDate()
    const prevProportionalEnd = new Date(previousMonthStart.getTime() + daysElapsed * 86_400_000)
    const prevCutoff = prevProportionalEnd < previousMonthEnd ? prevProportionalEnd : previousMonthEnd

    const pId = projectIdExpr(fields)
    const uTime = usageTimeExpr(fields)
    const cost = costExpr(fields)
    const svc = serviceExpr(fields)

    // Fetch current month's per-service costs
    const currentQuery = `
      SELECT ${svc} AS service, ROUND(SUM(${cost}), 2) AS amount
      FROM \`${table.projectId}.${table.datasetId}.${table.tableId}\`
      WHERE ${uTime} >= TIMESTAMP(@start) AND ${uTime} < TIMESTAMP(@end) AND ${pId} = @projectId
      GROUP BY service HAVING ABS(SUM(${cost})) > 0.01
    `.trim()

    const prevQuery = currentQuery // Same structure, different date params

    const [currentRows, prevRows] = await Promise.all([
      runBqQuery(table.projectId, table.location, currentQuery, [
        { name: 'start', type: 'TIMESTAMP', value: currentMonthStart.toISOString() },
        { name: 'end', type: 'TIMESTAMP', value: now.toISOString() },
        { name: 'projectId', type: 'STRING', value: pid }
      ]),
      runBqQuery(table.projectId, table.location, prevQuery, [
        { name: 'start', type: 'TIMESTAMP', value: previousMonthStart.toISOString() },
        { name: 'end', type: 'TIMESTAMP', value: prevCutoff.toISOString() },
        { name: 'projectId', type: 'STRING', value: pid }
      ])
    ])

    const prevMap = new Map(prevRows.map(([svc, amt]) => [svc, normalizeNumber(amt)]))
    const anomalies: GcpBillingCostAnomaly[] = []

    for (const [service, amountStr] of currentRows) {
      const currentAmount = normalizeNumber(amountStr)
      const previousAmount = prevMap.get(service) ?? 0
      const absoluteChange = currentAmount - previousAmount
      const percentChange = previousAmount > 0 ? ((currentAmount - previousAmount) / previousAmount) * 100 : (currentAmount > 5 ? 100 : 0)

      // Flag as anomaly: >25% increase AND >$5 absolute increase
      if (percentChange > 25 && absoluteChange > 5) {
        let severity: GcpBillingCostAnomaly['severity'] = 'info'
        if (percentChange > 100 || absoluteChange > 100) severity = 'warning'
        if (percentChange > 200 || absoluteChange > 500) severity = 'critical'

        anomalies.push({
          service,
          currentAmount: Math.round(currentAmount * 100) / 100,
          previousAmount: Math.round(previousAmount * 100) / 100,
          absoluteChange: Math.round(absoluteChange * 100) / 100,
          percentChange: Math.round(percentChange * 10) / 10,
          severity,
          comparisonBasis: `${daysElapsed} days (proportional)`
        })
      }
    }

    return anomalies.sort((a, b) => b.absoluteChange - a.absoluteChange)
  } catch (error) {
    throw classifyGcpError(`detecting cost anomalies for project "${pid}"`, error, BQ_API)
  }
}
