import { useCallback, useEffect, useMemo, useState } from 'react'

export type RefreshReason = 'initial' | 'manual' | 'background' | 'workflow' | 'selection' | 'session'
export type FreshnessSource = 'live' | 'local'

export type FreshnessState = {
  fetchedAt: number | null
  loading: boolean
  stale: boolean
  refreshReason: RefreshReason | null
  source: FreshnessSource | null
}

function computeStale(fetchedAt: number | null, staleAfterMs: number): boolean {
  if (!fetchedAt) {
    return false
  }

  return Date.now() - fetchedAt >= staleAfterMs
}

function reasonLabel(reason: RefreshReason | null): string {
  switch (reason) {
    case 'background':
      return 'Background refresh'
    case 'workflow':
      return 'Refreshing workflow'
    case 'selection':
      return 'Refreshing selection'
    case 'session':
      return 'Checking session'
    case 'initial':
    case 'manual':
    default:
      return 'Refreshing'
  }
}

export function formatFreshnessAgo(fetchedAt: number | null): string {
  if (!fetchedAt) {
    return 'Not loaded yet'
  }

  const diffMs = Math.max(0, Date.now() - fetchedAt)
  const diffSeconds = Math.floor(diffMs / 1000)

  if (diffSeconds < 5) {
    return 'just now'
  }

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`
  }

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}

export function useFreshnessState({
  staleAfterMs = 5 * 60 * 1000,
  initialFetchedAt = null,
  initialSource = null
}: {
  staleAfterMs?: number
  initialFetchedAt?: number | null
  initialSource?: FreshnessSource | null
} = {}) {
  const [freshness, setFreshness] = useState<FreshnessState>(() => ({
    fetchedAt: initialFetchedAt,
    loading: false,
    stale: computeStale(initialFetchedAt, staleAfterMs),
    refreshReason: null,
    source: initialSource
  }))

  useEffect(() => {
    const timer = window.setInterval(() => {
      setFreshness((current) => {
        const stale = computeStale(current.fetchedAt, staleAfterMs)
        return stale === current.stale ? current : { ...current, stale }
      })
    }, 30_000)

    return () => window.clearInterval(timer)
  }, [staleAfterMs])

  const beginRefresh = useCallback((reason: RefreshReason = 'manual') => {
    setFreshness((current) => ({
      ...current,
      loading: true,
      stale: computeStale(current.fetchedAt, staleAfterMs),
      refreshReason: reason
    }))
  }, [staleAfterMs])

  const completeRefresh = useCallback((fetchedAt = Date.now(), source: FreshnessSource = 'live') => {
    setFreshness({
      fetchedAt,
      loading: false,
      stale: computeStale(fetchedAt, staleAfterMs),
      refreshReason: null,
      source
    })
  }, [staleAfterMs])

  const failRefresh = useCallback(() => {
    setFreshness((current) => ({
      ...current,
      loading: false,
      stale: computeStale(current.fetchedAt, staleAfterMs)
    }))
  }, [staleAfterMs])

  const replaceFetchedAt = useCallback((fetchedAt: number | null, source: FreshnessSource | null = null) => {
    setFreshness((current) => ({
      ...current,
      fetchedAt,
      stale: computeStale(fetchedAt, staleAfterMs),
      source: fetchedAt ? source : null
    }))
  }, [staleAfterMs])

  return {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh,
    replaceFetchedAt
  }
}

export function FreshnessIndicator({
  freshness,
  label = 'Last updated',
  staleLabel = 'Stale',
  idleSuffix,
  className = ''
}: {
  freshness: FreshnessState
  label?: string
  staleLabel?: string
  idleSuffix?: string
  className?: string
}) {
  const absoluteTime = useMemo(() => (
    freshness.fetchedAt ? new Date(freshness.fetchedAt).toLocaleTimeString() : ''
  ), [freshness.fetchedAt])

  return (
    <div className={`freshness-indicator${className ? ` ${className}` : ''}`}>
      <div className="freshness-indicator__summary">
        <span className="freshness-indicator__label">{label}</span>
        <strong title={absoluteTime || undefined}>
          {freshness.fetchedAt ? `${formatFreshnessAgo(freshness.fetchedAt)}${idleSuffix ? ` ${idleSuffix}` : ''}` : 'Waiting for first load'}
        </strong>
      </div>
      <div className="freshness-indicator__badges">
        {freshness.loading && <span className="freshness-pill loading">{reasonLabel(freshness.refreshReason)}</span>}
        {freshness.fetchedAt && freshness.source === 'local' && <span className="freshness-pill cached">Cached</span>}
        {!freshness.loading && freshness.stale && <span className="freshness-pill stale">{staleLabel}</span>}
        {freshness.fetchedAt && !freshness.loading && !freshness.stale && freshness.source !== 'local' && (
          <span className="freshness-pill ready">Fresh</span>
        )}
      </div>
    </div>
  )
}
