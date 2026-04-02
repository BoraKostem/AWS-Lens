import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { LEGACY_STORAGE_NAMESPACE } from '@shared/branding'
import {
  toProviderConnectionDescriptor,
  toProviderLocationDescriptor,
  toProviderProfileDescriptor
} from '@shared/providerAdapters'
import type {
  AwsConnection,
  AwsProfile,
  AwsRegionOption,
  AwsSessionSummary,
  AwsAssumeRoleTarget,
  CallerIdentity,
  ProviderConnectionDescriptor,
  ProviderLocationDescriptor,
  ProviderProfileDescriptor
} from '@shared/types'
import { getCallerIdentity, getSessionHubState, listProfiles, listRegions } from './api'

const PROFILE_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:selected-profile`
const REGION_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:selected-region`
const PINNED_PROFILES_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:pinned-profiles`
const ACTIVE_SESSION_ID_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:active-session-id`

function readStoredValue(key: string, fallback: string): string {
  if (typeof window === 'undefined') {
    return fallback
  }

  return window.localStorage.getItem(key) ?? fallback
}

function hasStoredValue(key: string): boolean {
  if (typeof window === 'undefined') {
    return false
  }

  return window.localStorage.getItem(key) !== null
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

  if (!value) {
    window.localStorage.removeItem(key)
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

export function useAwsPageConnection(defaultRegion = 'eu-central-1', defaultProfileName = '', defaultsHydrated = false) {
  const [profiles, setProfiles] = useState<AwsProfile[]>([])
  const [regions, setRegions] = useState<AwsRegionOption[]>([])
  const [profile, setProfile] = useState(() => readStoredValue(PROFILE_STORAGE_KEY, ''))
  const [region, setRegion] = useState(() => readStoredValue(REGION_STORAGE_KEY, defaultRegion))
  const [pinnedProfileNames, setPinnedProfileNames] = useState<string[]>(() => readStoredList(PINNED_PROFILES_STORAGE_KEY))
  const [targets, setTargets] = useState<AwsAssumeRoleTarget[]>([])
  const [sessions, setSessions] = useState<AwsSessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState(() => readStoredValue(ACTIVE_SESSION_ID_STORAGE_KEY, ''))
  const [identity, setIdentity] = useState<CallerIdentity | null>(null)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState('')
  const appliedDefaultRegionRef = useRef('')

  useEffect(() => {
    void (async () => {
      try {
        const [loadedProfiles, loadedRegions, sessionState] = await Promise.all([listProfiles(), listRegions(), getSessionHubState()])
        setProfiles(loadedProfiles)
        setRegions(loadedRegions)
        setTargets(sessionState.targets)
        setSessions(sessionState.sessions)
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

  useEffect(() => {
    writeStoredValue(ACTIVE_SESSION_ID_STORAGE_KEY, activeSessionId)
  }, [activeSessionId])

  function selectProfile(name: string): void {
    setProfile(name)
    setActiveSessionId('')
    const match = profiles.find((entry) => entry.name === name)
    if (match?.region) {
      setRegion(match.region)
    }
  }

  // Profile is only set by explicit user selection — no auto-select

  useEffect(() => {
    if (!defaultsHydrated || activeSessionId || !defaultRegion) {
      return
    }

    if (appliedDefaultRegionRef.current === defaultRegion) {
      return
    }

    if (region !== defaultRegion) {
      setRegion(defaultRegion)
    }

    appliedDefaultRegionRef.current = defaultRegion
  }, [activeSessionId, defaultRegion, defaultsHydrated, region])

  useEffect(() => {
    if (hasStoredValue(PROFILE_STORAGE_KEY) || activeSessionId || profile || !defaultProfileName) {
      return
    }

    const match = profiles.find((entry) => entry.name === defaultProfileName)
    if (!match) {
      return
    }

    setProfile(match.name)
    if (!hasStoredValue(REGION_STORAGE_KEY)) {
      if (defaultRegion) {
        setRegion(defaultRegion)
        return
      }

      if (match.region) {
        setRegion(match.region)
      }
    }
  }, [activeSessionId, defaultProfileName, defaultRegion, profile, profiles])

  const activeSession = useMemo(
    () => sessions.find((entry) => entry.id === activeSessionId) ?? null,
    [activeSessionId, sessions]
  )

  useEffect(() => {
    if (activeSessionId && !activeSession) {
      setActiveSessionId('')
    }
  }, [activeSession, activeSessionId])

  const connection = useMemo<AwsConnection | null>(() => {
    if (!region) return null
    if (activeSession) {
      return {
        providerId: 'aws',
        kind: 'assumed-role',
        sessionId: activeSession.id,
        label: activeSession.label,
        profileId: activeSession.profile,
        locationId: region,
        profile: activeSession.profile,
        sourceProfile: activeSession.sourceProfile,
        region,
        roleArn: activeSession.roleArn,
        assumedRoleArn: activeSession.assumedRoleArn,
        accountId: activeSession.accountId,
        accessKeyId: activeSession.accessKeyId,
        expiration: activeSession.expiration,
        externalId: activeSession.externalId
      }
    }
    if (!profile) return null
    return {
      providerId: 'aws',
      kind: 'profile',
      sessionId: `profile:${profile}`,
      label: profile,
      profileId: profile,
      locationId: region,
      profile,
      region
    }
  }, [activeSession, profile, region])

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

  const providerProfiles = useMemo<ProviderProfileDescriptor[]>(
    () => profiles.map((entry) => toProviderProfileDescriptor(entry, entry.name === profile)),
    [profile, profiles]
  )

  const providerLocations = useMemo<ProviderLocationDescriptor[]>(
    () => regions.map((entry) => toProviderLocationDescriptor(entry)),
    [regions]
  )

  const providerConnection = useMemo<ProviderConnectionDescriptor | null>(() => {
    if (!connection) {
      return null
    }

    return toProviderConnectionDescriptor(connection, selectedRegion?.name || connection.region)
  }, [connection, selectedRegion])

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

  async function refreshProfiles(): Promise<void> {
    try {
      const [loadedProfiles, loadedRegions, sessionState] = await Promise.all([listProfiles(), listRegions(), getSessionHubState()])
      setProfiles(loadedProfiles)
      setRegions(loadedRegions)
      setTargets(sessionState.targets)
      setSessions(sessionState.sessions)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function activateSession(sessionId: string): void {
    const nextSession = sessions.find((entry) => entry.id === sessionId)
    if (!nextSession) {
      return
    }
    setActiveSessionId(sessionId)
    if (nextSession.region) {
      setRegion(nextSession.region)
    }
  }

  function clearActiveSession(): void {
    setActiveSessionId('')
  }

  return {
    providerId: 'aws' as const,
    profiles,
    providerProfiles,
    regions,
    providerLocations,
    profile,
    setProfile,
    selectProfile,
    region,
    setRegion,
    pinnedProfileNames,
    pinnedProfiles,
    togglePinnedProfile,
    targets,
    sessions,
    activeSessionId,
    activeSession,
    activateSession,
    clearActiveSession,
    selectedProfile,
    selectedRegion,
    identity,
    connected,
    connecting,
    error,
    setError,
    connection,
    providerConnection,
    connect,
    refreshProfiles
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

    const readyKey = `${state.connection.sessionId}:${state.connection.region}`
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
