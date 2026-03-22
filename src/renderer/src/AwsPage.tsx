import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import type { AwsConnection, AwsProfile, AwsRegionOption, CallerIdentity } from '@shared/types'
import { getCallerIdentity, listProfiles, listRegions } from './api'

const PROFILE_STORAGE_KEY = 'aws-lens:selected-profile'
const REGION_STORAGE_KEY = 'aws-lens:selected-region'
const PINNED_PROFILES_STORAGE_KEY = 'aws-lens:pinned-profiles'

function readStoredValue(key: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback
  }

  return window.localStorage.getItem(key) ?? fallback
}

function readStoredList(key: string): string[] {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function writeStoredValue(key: string, value: string): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(key, value)
}

function writeStoredList(key: string, values: string[]): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(key, JSON.stringify(values))
}

export function formatDateTime(value?: string): string {
  return value ? new Date(value).toLocaleString() : '-'
}

export function useAwsPageConnection(defaultRegion = 'eu-central-1') {
  const [profiles, setProfiles] = useState<AwsProfile[]>([])
  const [regions, setRegions] = useState<AwsRegionOption[]>([])
  const [profile, setProfile] = useState('')
  const [region, setRegion] = useState(() => readStoredValue(REGION_STORAGE_KEY, defaultRegion))
  const [pinnedProfileNames, setPinnedProfileNames] = useState<string[]>(() => readStoredList(PINNED_PROFILES_STORAGE_KEY))
  const [identity, setIdentity] = useState<CallerIdentity | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void (async () => {
      try {
        const [loadedProfiles, loadedRegions] = await Promise.all([listProfiles(), listRegions()])
        setProfiles(loadedProfiles)
        setRegions(loadedRegions)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [])

  useEffect(() => {
    writeStoredValue(PROFILE_STORAGE_KEY, profile)
  }, [profile])

  useEffect(() => {
    writeStoredValue(REGION_STORAGE_KEY, region)
  }, [region])

  useEffect(() => {
    writeStoredList(PINNED_PROFILES_STORAGE_KEY, pinnedProfileNames)
  }, [pinnedProfileNames])

  // Profile is only set by explicit user selection — no auto-select

  const connection = useMemo<AwsConnection | null>(() => {
    if (!profile || !region) return null
    return { profile, region }
  }, [profile, region])

  const selectedProfile = useMemo(
    () => profiles.find((entry) => entry.name === profile) ?? null,
    [profile, profiles]
  )

  const selectedRegion = useMemo(
    () => regions.find((entry) => entry.id === region) ?? null,
    [region, regions]
  )

  const pinnedProfiles = useMemo(() => {
    const profileMap = new Map(profiles.map((entry) => [entry.name, entry]))
    return pinnedProfileNames.map((name) => profileMap.get(name)).filter((entry): entry is AwsProfile => Boolean(entry))
  }, [pinnedProfileNames, profiles])

  function togglePinnedProfile(name: string): void {
    setPinnedProfileNames((current) => {
      if (current.includes(name)) {
        return current.filter((entry) => entry !== name)
      }
      return [...current, name]
    })
  }

  async function hydrateConnection(nextConnection: AwsConnection): Promise<AwsConnection | null> {
    setConnecting(true)
    setError('')
    setConnected(false)
    try {
      const caller = await getCallerIdentity(nextConnection)
      setIdentity(caller)
      setConnected(true)
      return nextConnection
    } catch (err) {
      setIdentity(null)
      setConnected(false)
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setConnecting(false)
    }
  }

  useEffect(() => {
    if (!connection) {
      setIdentity(null)
      setConnected(false)
      setConnecting(false)
      setError('')
      return
    }

    void hydrateConnection(connection)
  }, [connection])

  async function connect(): Promise<AwsConnection | null> {
    if (!connection) return null
    return hydrateConnection(connection)
  }

  return {
    profiles,
    regions,
    profile,
    setProfile,
    region,
    setRegion,
    pinnedProfileNames,
    pinnedProfiles,
    togglePinnedProfile,
    selectedProfile,
    selectedRegion,
    identity,
    connected,
    connecting,
    error,
    setError,
    connection,
    connect
  }
}

export function AwsPageShell({
  title,
  subtitle,
  onBack,
  sidebarChildren,
  children
}: {
  title: string
  subtitle: string
  onBack: () => void
  sidebarChildren: ReactNode
  children: ReactNode
}) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="eyebrow">
            <button type="button" className="back-link" onClick={onBack}>Services</button>
          </div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <div className="panel stack">{sidebarChildren}</div>
      </aside>
      <main className="workspace">{children}</main>
    </div>
  )
}

export function AwsConnectionPanel({
  state,
  onConnectionReady,
  children
}: {
  state: ReturnType<typeof useAwsPageConnection>
  onConnectionReady?: (connection: AwsConnection) => void
  children?: ReactNode
}) {
  const lastReadyKeyRef = useRef('')

  useEffect(() => {
    if (!state.connected || !state.connection || !onConnectionReady) {
      return
    }

    const readyKey = `${state.connection.profile}:${state.connection.region}`
    if (lastReadyKeyRef.current === readyKey) {
      return
    }

    lastReadyKeyRef.current = readyKey
    onConnectionReady(state.connection)
  }, [onConnectionReady, state.connected, state.connection])

  return (
    <>
      <label className="field">
        <span>Region</span>
        <select value={state.region} onChange={(event) => state.setRegion(event.target.value)}>
          {state.regions.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.id} · {entry.name}
            </option>
          ))}
        </select>
      </label>
      {state.identity && (
        <div className="ct-identity">
          <div className="ct-identity-arn">{state.identity.arn}</div>
          <div className="ct-identity-acct">Account: {state.identity.account}</div>
        </div>
      )}
      {children}
    </>
  )
}
