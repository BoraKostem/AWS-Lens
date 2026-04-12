/**
 * Azure Cost Management — extends the existing cost surface in azureSdk.ts
 * with historical trends, forecasting, budgets, tag-based allocation,
 * reservation utilization, and anomaly detection.
 *
 * Uses Azure Cost Management REST API via fetchAzureArmJson.
 * Depends on: azure/client.ts (fetchAzureArmJson, fetchAzureArmCollection, classifyAzureError)
 */

import { classifyAzureError, fetchAzureArmJson, fetchAzureArmCollection } from './client'
import type {
  AzureCostTrend,
  AzureCostTrendMonth,
  AzureCostByResourceGroup,
  AzureCostResourceGroupEntry,
  AzureCostByMeterCategory,
  AzureCostMeterEntry,
  AzureCostByTag,
  AzureCostTagEntry,
  AzureCostForecast,
  AzureCostForecastEntry,
  AzureBudgetSummary,
  AzureReservationUtilization,
  AzureReservationEntry,
  AzureCostAnomaly
} from '@shared/types'

// ── Constants ───────────────────────────────────────────────────────────────────

const COST_API_VERSION = '2023-11-01'
const BUDGET_API_VERSION = '2023-11-01'
const CONSUMPTION_API_VERSION = '2023-05-01'

type CostQueryResponse = {
  properties?: {
    columns?: Array<{ name?: string }>
    rows?: Array<Array<string | number | null>>
    nextLink?: string
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function buildCostQueryScope(subscriptionId: string): string {
  return `/subscriptions/${encodeURIComponent(subscriptionId.trim())}/providers/Microsoft.CostManagement/query`
}

function parseCostRows(response: CostQueryResponse): {
  columns: string[]
  rows: Array<Array<string | number | null>>
} {
  const columns = (response.properties?.columns ?? []).map((c) => (c.name ?? '').trim())
  const rows = response.properties?.rows ?? []
  return { columns, rows }
}

function colIndex(columns: string[], name: string): number {
  return columns.findIndex((c) => c.toLowerCase() === name.toLowerCase())
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function formatCostDate(raw: string | number | null): string {
  const s = String(raw ?? '')
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s
}

// ── Monthly Cost Trend ──────────────────────────────────────────────────────────

/**
 * Returns month-over-month cost totals and top services for the last N months.
 * Uses Azure Cost Management's "Custom" timeframe with monthly granularity.
 *
 * Requires: Microsoft.CostManagement/query/read
 */
export async function getAzureCostTrend(
  subscriptionId: string,
  months = 6
): Promise<AzureCostTrend> {
  const subId = subscriptionId.trim()
  if (!subId) {
    return { subscriptionId: '', months: [], currency: '', message: 'No subscription selected.' }
  }

  try {
    const now = new Date()
    const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months + 1, 1))
    const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))

    const response = await fetchAzureArmJson<CostQueryResponse>(
      buildCostQueryScope(subId),
      COST_API_VERSION,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'Usage',
          timeframe: 'Custom',
          timePeriod: {
            from: startDate.toISOString().split('T')[0],
            to: endDate.toISOString().split('T')[0]
          },
          dataset: {
            granularity: 'Monthly',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
            grouping: [{ type: 'Dimension', name: 'ServiceName' }]
          }
        })
      }
    )

    const { columns, rows } = parseCostRows(response)
    const costIdx = colIndex(columns, 'Cost')
    const serviceIdx = colIndex(columns, 'ServiceName')
    const dateIdx = colIndex(columns, 'BillingMonth') !== -1 ? colIndex(columns, 'BillingMonth') : colIndex(columns, 'UsageDate')
    const currencyIdx = colIndex(columns, 'Currency')

    const monthMap = new Map<string, { total: number; services: Map<string, number>; currency: string }>()

    for (const row of rows) {
      const cost = Number(row[costIdx] ?? 0)
      const service = String(row[serviceIdx] ?? 'Unknown')
      const rawDate = formatCostDate(row[dateIdx])
      const month = rawDate.slice(0, 7) // YYYY-MM
      const currency = String(row[currencyIdx] ?? 'USD')

      if (!monthMap.has(month)) monthMap.set(month, { total: 0, services: new Map(), currency })
      const bucket = monthMap.get(month)!
      bucket.total += cost
      bucket.services.set(service, (bucket.services.get(service) ?? 0) + cost)
      if (currency) bucket.currency = currency
    }

    const currency = [...monthMap.values()].find((b) => b.currency)?.currency ?? 'USD'
    const monthEntries: AzureCostTrendMonth[] = [...monthMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, bucket]) => ({
        month,
        totalAmount: round2(bucket.total),
        currency: bucket.currency || currency,
        topServices: [...bucket.services.entries()]
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([service, amount]) => ({ service, amount: round2(amount) }))
      }))

    return {
      subscriptionId: subId,
      months: monthEntries,
      currency,
      message: monthEntries.length > 0
        ? `Cost trend for ${monthEntries.length} months.`
        : 'No cost data returned for the requested period.'
    }
  } catch (error) {
    throw classifyAzureError(`loading cost trend for subscription "${subId}"`, error)
  }
}

// ── Cost By Resource Group ──────────────────────────────────────────────────────

/**
 * Current-month cost breakdown by resource group with service detail.
 */
export async function getAzureCostByResourceGroup(
  subscriptionId: string
): Promise<AzureCostByResourceGroup> {
  const subId = subscriptionId.trim()
  if (!subId) {
    return { subscriptionId: '', entries: [], totalAmount: 0, currency: '', message: 'No subscription selected.' }
  }

  try {
    const response = await fetchAzureArmJson<CostQueryResponse>(
      buildCostQueryScope(subId),
      COST_API_VERSION,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'Usage',
          timeframe: 'MonthToDate',
          dataset: {
            granularity: 'None',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
            grouping: [
              { type: 'Dimension', name: 'ResourceGroupName' },
              { type: 'Dimension', name: 'ServiceName' }
            ]
          }
        })
      }
    )

    const { columns, rows } = parseCostRows(response)
    const costIdx = colIndex(columns, 'Cost')
    const rgIdx = colIndex(columns, 'ResourceGroupName')
    const svcIdx = colIndex(columns, 'ServiceName')
    const currencyIdx = colIndex(columns, 'Currency')

    const rgMap = new Map<string, { total: number; services: Map<string, number> }>()
    let currency = 'USD'

    for (const row of rows) {
      const cost = Number(row[costIdx] ?? 0)
      const rg = String(row[rgIdx] ?? '(unassigned)')
      const svc = String(row[svcIdx] ?? 'Unknown')
      const cur = String(row[currencyIdx] ?? '')
      if (cur) currency = cur

      if (!rgMap.has(rg)) rgMap.set(rg, { total: 0, services: new Map() })
      const bucket = rgMap.get(rg)!
      bucket.total += cost
      bucket.services.set(svc, (bucket.services.get(svc) ?? 0) + cost)
    }

    const totalAmount = [...rgMap.values()].reduce((sum, b) => sum + b.total, 0)
    const entries: AzureCostResourceGroupEntry[] = [...rgMap.entries()]
      .sort(([, a], [, b]) => b.total - a.total)
      .slice(0, 25)
      .map(([name, bucket]) => ({
        resourceGroup: name,
        amount: round2(bucket.total),
        currency,
        sharePercent: totalAmount > 0 ? round2((bucket.total / totalAmount) * 100) : 0,
        topServices: [...bucket.services.entries()]
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([svc, amt]) => ({ service: svc, amount: round2(amt) }))
      }))

    return {
      subscriptionId: subId,
      entries,
      totalAmount: round2(totalAmount),
      currency,
      message: entries.length > 0 ? `Breakdown across ${rgMap.size} resource groups.` : 'No cost data returned.'
    }
  } catch (error) {
    throw classifyAzureError(`loading cost by resource group for subscription "${subId}"`, error)
  }
}

// ── Cost By Meter Category ──────────────────────────────────────────────────────

/**
 * Current-month cost breakdown by meter category (the Azure equivalent of
 * GCP's SKU-level cost drill-down).
 */
export async function getAzureCostByMeterCategory(
  subscriptionId: string
): Promise<AzureCostByMeterCategory> {
  const subId = subscriptionId.trim()
  if (!subId) {
    return { subscriptionId: '', entries: [], totalAmount: 0, currency: '', message: 'No subscription selected.' }
  }

  try {
    const response = await fetchAzureArmJson<CostQueryResponse>(
      buildCostQueryScope(subId),
      COST_API_VERSION,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'Usage',
          timeframe: 'MonthToDate',
          dataset: {
            granularity: 'None',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
            grouping: [
              { type: 'Dimension', name: 'MeterCategory' },
              { type: 'Dimension', name: 'MeterSubCategory' }
            ]
          }
        })
      }
    )

    const { columns, rows } = parseCostRows(response)
    const costIdx = colIndex(columns, 'Cost')
    const catIdx = colIndex(columns, 'MeterCategory')
    const subCatIdx = colIndex(columns, 'MeterSubCategory')
    const currencyIdx = colIndex(columns, 'Currency')

    let currency = 'USD'
    const entries: AzureCostMeterEntry[] = []

    for (const row of rows) {
      const cost = Number(row[costIdx] ?? 0)
      const category = String(row[catIdx] ?? 'Unknown')
      const subCategory = String(row[subCatIdx] ?? '')
      const cur = String(row[currencyIdx] ?? '')
      if (cur) currency = cur
      if (Math.abs(cost) > 0.009) {
        entries.push({ meterCategory: category, meterSubCategory: subCategory, amount: round2(cost), currency, sharePercent: 0 })
      }
    }

    entries.sort((a, b) => b.amount - a.amount)
    const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0)
    for (const entry of entries) {
      entry.sharePercent = totalAmount > 0 ? round2((entry.amount / totalAmount) * 100) : 0
    }

    return {
      subscriptionId: subId,
      entries: entries.slice(0, 30),
      totalAmount: round2(totalAmount),
      currency,
      message: entries.length > 0 ? `Meter breakdown across ${entries.length} categories.` : 'No cost data returned.'
    }
  } catch (error) {
    throw classifyAzureError(`loading cost by meter category for subscription "${subId}"`, error)
  }
}

// ── Cost By Tag ─────────────────────────────────────────────────────────────────

/**
 * Current-month cost breakdown by a specific tag key. Useful for team,
 * environment, or cost-center allocation.
 */
export async function getAzureCostByTag(
  subscriptionId: string,
  tagKey: string
): Promise<AzureCostByTag> {
  const subId = subscriptionId.trim()
  const normalizedKey = tagKey.trim()
  if (!subId || !normalizedKey) {
    return { subscriptionId: '', tagKey: '', entries: [], totalAmount: 0, currency: '', message: 'Missing subscription or tag key.' }
  }

  try {
    const response = await fetchAzureArmJson<CostQueryResponse>(
      buildCostQueryScope(subId),
      COST_API_VERSION,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'Usage',
          timeframe: 'MonthToDate',
          dataset: {
            granularity: 'None',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
            grouping: [{ type: 'Tag', name: normalizedKey }]
          }
        })
      }
    )

    const { columns, rows } = parseCostRows(response)
    const costIdx = colIndex(columns, 'Cost')
    const tagIdx = colIndex(columns, normalizedKey) !== -1 ? colIndex(columns, normalizedKey) : colIndex(columns, 'Tag')
    const currencyIdx = colIndex(columns, 'Currency')

    let currency = 'USD'
    const totalAmount = rows.reduce((sum, row) => sum + Number(row[costIdx] ?? 0), 0)
    const entries: AzureCostTagEntry[] = rows
      .map((row) => {
        const cost = Number(row[costIdx] ?? 0)
        const tagValue = String(row[tagIdx] ?? '(untagged)')
        const cur = String(row[currencyIdx] ?? '')
        if (cur) currency = cur
        return {
          tagValue,
          amount: round2(cost),
          currency,
          sharePercent: totalAmount > 0 ? round2((cost / totalAmount) * 100) : 0
        }
      })
      .filter((e) => Math.abs(e.amount) > 0.009)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 50)

    return {
      subscriptionId: subId,
      tagKey: normalizedKey,
      entries,
      totalAmount: round2(totalAmount),
      currency,
      message: entries.length > 0 ? `Tag "${normalizedKey}" breakdown across ${entries.length} values.` : 'No cost data returned for this tag.'
    }
  } catch (error) {
    throw classifyAzureError(`loading cost by tag "${normalizedKey}" for subscription "${subId}"`, error)
  }
}

// ── Cost Forecast ───────────────────────────────────────────────────────────────

/**
 * Uses Azure Cost Management's forecast API to project costs for the rest
 * of the current month.
 *
 * Requires: Microsoft.CostManagement/forecast/read
 */
export async function getAzureCostForecast(
  subscriptionId: string
): Promise<AzureCostForecast> {
  const subId = subscriptionId.trim()
  if (!subId) {
    return { subscriptionId: '', actualTotal: 0, forecastTotal: 0, entries: [], currency: '', confidence: 'low', message: 'No subscription selected.' }
  }

  try {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))

    const scope = `/subscriptions/${encodeURIComponent(subId)}/providers/Microsoft.CostManagement/forecast`
    const response = await fetchAzureArmJson<CostQueryResponse>(
      scope,
      COST_API_VERSION,
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'Usage',
          timeframe: 'Custom',
          timePeriod: {
            from: monthStart.toISOString().split('T')[0],
            to: monthEnd.toISOString().split('T')[0]
          },
          dataset: {
            granularity: 'Daily',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }
          },
          includeActualCost: true,
          includeFreshPartialCost: false
        })
      }
    )

    const { columns, rows } = parseCostRows(response)
    const costIdx = colIndex(columns, 'Cost')
    const dateIdx = colIndex(columns, 'UsageDate') !== -1 ? colIndex(columns, 'UsageDate') : colIndex(columns, 'BillingMonth')
    const currencyIdx = colIndex(columns, 'Currency')
    const costTypeIdx = colIndex(columns, 'CostStatus') !== -1 ? colIndex(columns, 'CostStatus') : colIndex(columns, 'ChargeType')

    let currency = 'USD'
    let actualTotal = 0
    let forecastTotal = 0
    const entries: AzureCostForecastEntry[] = []

    for (const row of rows) {
      const cost = Number(row[costIdx] ?? 0)
      const date = formatCostDate(row[dateIdx])
      const cur = String(row[currencyIdx] ?? '')
      const costType = String(row[costTypeIdx] ?? '').toLowerCase()
      if (cur) currency = cur

      const isActual = costType === 'actual' || costType === '' || !costType
      if (isActual) actualTotal += cost
      else forecastTotal += cost

      entries.push({
        date,
        amount: round2(cost),
        costType: isActual ? 'actual' : 'forecast',
        currency
      })
    }

    const totalProjected = actualTotal + forecastTotal
    const daysElapsed = Math.max(1, Math.ceil((now.getTime() - monthStart.getTime()) / 86_400_000))
    let confidence: AzureCostForecast['confidence'] = 'low'
    if (daysElapsed >= 14) confidence = 'high'
    else if (daysElapsed >= 7) confidence = 'medium'

    return {
      subscriptionId: subId,
      actualTotal: round2(actualTotal),
      forecastTotal: round2(totalProjected),
      entries: entries.sort((a, b) => a.date.localeCompare(b.date)),
      currency,
      confidence,
      message: `Forecast based on ${daysElapsed} days of actual data.`
    }
  } catch (error) {
    throw classifyAzureError(`loading cost forecast for subscription "${subId}"`, error)
  }
}

// ── Budget Management ───────────────────────────────────────────────────────────

/**
 * Lists all budgets defined for the subscription.
 * Requires: Microsoft.Consumption/budgets/read
 */
export async function listAzureBudgets(
  subscriptionId: string
): Promise<AzureBudgetSummary[]> {
  const subId = subscriptionId.trim()
  if (!subId) return []

  try {
    const records = await fetchAzureArmCollection<Record<string, unknown>>(
      `/subscriptions/${encodeURIComponent(subId)}/providers/Microsoft.Consumption/budgets`,
      BUDGET_API_VERSION
    )

    return records.map((record) => {
      const props = (record.properties ?? {}) as Record<string, unknown>
      const amount = Number(props.amount ?? 0)
      const timeGrain = String(props.timeGrain ?? 'Monthly')
      const timePeriod = (props.timePeriod ?? {}) as Record<string, unknown>
      const currentSpend = (props.currentSpend ?? {}) as Record<string, unknown>
      const forecastSpend = (props.forecastSpend ?? {}) as Record<string, unknown>
      const notifications = (props.notifications ?? {}) as Record<string, unknown>

      const thresholds: number[] = []
      for (const [, notif] of Object.entries(notifications)) {
        const n = notif as Record<string, unknown>
        const threshold = Number(n.threshold ?? 0)
        if (threshold > 0 && !thresholds.includes(threshold)) thresholds.push(threshold)
      }

      return {
        name: String(record.name ?? ''),
        id: String(record.id ?? ''),
        amount,
        timeGrain,
        currency: String((currentSpend as Record<string, unknown>).unit ?? 'USD'),
        startDate: String(timePeriod.startDate ?? ''),
        endDate: String(timePeriod.endDate ?? ''),
        currentSpend: Number((currentSpend as Record<string, unknown>).amount ?? 0),
        forecastSpend: Number((forecastSpend as Record<string, unknown>).amount ?? 0),
        thresholdPercents: thresholds.sort((a, b) => a - b),
        category: String(props.category ?? 'Cost'),
        utilizationPercent: amount > 0
          ? round2((Number((currentSpend as Record<string, unknown>).amount ?? 0) / amount) * 100)
          : 0
      } satisfies AzureBudgetSummary
    }).sort((a, b) => a.name.localeCompare(b.name))
  } catch (error) {
    throw classifyAzureError(`listing budgets for subscription "${subId}"`, error)
  }
}

// ── Reservation Utilization ─────────────────────────────────────────────────────

/**
 * Fetches reservation utilization summaries for the current month.
 * Requires: Microsoft.Consumption/reservationSummaries/read
 */
export async function getAzureReservationUtilization(
  subscriptionId: string
): Promise<AzureReservationUtilization> {
  const subId = subscriptionId.trim()
  if (!subId) {
    return { subscriptionId: '', entries: [], averageUtilization: 0, message: 'No subscription selected.' }
  }

  try {
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

    const records = await fetchAzureArmCollection<Record<string, unknown>>(
      `/subscriptions/${encodeURIComponent(subId)}/providers/Microsoft.Consumption/reservationSummaries?grain=monthly&startDate=${monthStart.toISOString().split('T')[0]}&endDate=${now.toISOString().split('T')[0]}`,
      CONSUMPTION_API_VERSION
    )

    const entries: AzureReservationEntry[] = records.map((record) => {
      const props = (record.properties ?? {}) as Record<string, unknown>
      return {
        reservationId: String(props.reservationId ?? record.id ?? ''),
        reservationOrderId: String(props.reservationOrderId ?? ''),
        skuName: String(props.skuName ?? 'Unknown'),
        avgUtilizationPercent: Number(props.avgUtilizationPercentage ?? 0),
        minUtilizationPercent: Number(props.minUtilizationPercentage ?? 0),
        maxUtilizationPercent: Number(props.maxUtilizationPercentage ?? 0),
        reservedHours: Number(props.reservedHours ?? 0),
        usedHours: Number(props.usedHours ?? 0),
        usageDate: String(props.usageDate ?? '')
      }
    })

    const avgUtilization = entries.length > 0
      ? round2(entries.reduce((sum, e) => sum + e.avgUtilizationPercent, 0) / entries.length)
      : 0

    return {
      subscriptionId: subId,
      entries: entries.sort((a, b) => a.avgUtilizationPercent - b.avgUtilizationPercent),
      averageUtilization: avgUtilization,
      message: entries.length > 0
        ? `${entries.length} reservation(s) with ${avgUtilization}% average utilization.`
        : 'No reservation utilization data found for the current period.'
    }
  } catch (error) {
    // Reservation data may not be available for all subscription types
    const detail = error instanceof Error ? error.message : String(error)
    if (detail.includes('404') || detail.includes('not found') || detail.includes('BillingAccountNotFound')) {
      return { subscriptionId: subId, entries: [], averageUtilization: 0, message: 'Reservation data not available for this subscription type.' }
    }
    throw classifyAzureError(`loading reservation utilization for subscription "${subId}"`, error)
  }
}

// ── Cost Anomaly Detection ──────────────────────────────────────────────────────

/**
 * Compares current-month-to-date service costs against the same period in the
 * previous month to detect significant increases. Flags services with >25%
 * and >$5 increase.
 */
export async function getAzureCostAnomalies(
  subscriptionId: string
): Promise<AzureCostAnomaly[]> {
  const subId = subscriptionId.trim()
  if (!subId) return []

  try {
    const now = new Date()
    const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const previousMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    const daysElapsed = Math.max(1, Math.ceil((now.getTime() - currentMonthStart.getTime()) / 86_400_000))
    const previousCutoff = new Date(previousMonthStart.getTime() + daysElapsed * 86_400_000)

    const scope = buildCostQueryScope(subId)

    const [currentResponse, previousResponse] = await Promise.all([
      fetchAzureArmJson<CostQueryResponse>(scope, COST_API_VERSION, {
        method: 'POST',
        body: JSON.stringify({
          type: 'Usage',
          timeframe: 'MonthToDate',
          dataset: {
            granularity: 'None',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
            grouping: [{ type: 'Dimension', name: 'ServiceName' }]
          }
        })
      }),
      fetchAzureArmJson<CostQueryResponse>(scope, COST_API_VERSION, {
        method: 'POST',
        body: JSON.stringify({
          type: 'Usage',
          timeframe: 'Custom',
          timePeriod: {
            from: previousMonthStart.toISOString().split('T')[0],
            to: previousCutoff.toISOString().split('T')[0]
          },
          dataset: {
            granularity: 'None',
            aggregation: { totalCost: { name: 'Cost', function: 'Sum' } },
            grouping: [{ type: 'Dimension', name: 'ServiceName' }]
          }
        })
      })
    ])

    // Parse current month
    const current = parseCostRows(currentResponse)
    const currentCostIdx = colIndex(current.columns, 'Cost')
    const currentSvcIdx = colIndex(current.columns, 'ServiceName')

    // Parse previous month
    const previous = parseCostRows(previousResponse)
    const prevCostIdx = colIndex(previous.columns, 'Cost')
    const prevSvcIdx = colIndex(previous.columns, 'ServiceName')

    const prevMap = new Map<string, number>()
    for (const row of previous.rows) {
      const svc = String(row[prevSvcIdx] ?? '')
      const cost = Number(row[prevCostIdx] ?? 0)
      prevMap.set(svc, (prevMap.get(svc) ?? 0) + cost)
    }

    const anomalies: AzureCostAnomaly[] = []
    for (const row of current.rows) {
      const service = String(row[currentSvcIdx] ?? '')
      const currentAmount = Number(row[currentCostIdx] ?? 0)
      const previousAmount = prevMap.get(service) ?? 0
      const absoluteChange = currentAmount - previousAmount
      const percentChange = previousAmount > 0
        ? ((currentAmount - previousAmount) / previousAmount) * 100
        : (currentAmount > 5 ? 100 : 0)

      if (percentChange > 25 && absoluteChange > 5) {
        let severity: AzureCostAnomaly['severity'] = 'info'
        if (percentChange > 100 || absoluteChange > 100) severity = 'warning'
        if (percentChange > 200 || absoluteChange > 500) severity = 'critical'

        anomalies.push({
          service,
          currentAmount: round2(currentAmount),
          previousAmount: round2(previousAmount),
          absoluteChange: round2(absoluteChange),
          percentChange: round2(percentChange),
          severity,
          comparisonBasis: `${daysElapsed} days (proportional)`
        })
      }
    }

    return anomalies.sort((a, b) => b.absoluteChange - a.absoluteChange)
  } catch (error) {
    throw classifyAzureError(`detecting cost anomalies for subscription "${subId}"`, error)
  }
}
