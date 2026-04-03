import { useEffect, useMemo, useState } from 'react'

import type {
  AssumeRoleRequest,
  AwsAssumeRoleTarget,
  AwsConnection,
  AwsSessionSummary,
  ComparisonPreset,
  ComparisonPresetSummary,
  ComparisonRequest,
  IamRoleSummary
} from '@shared/types'
import {
  assumeRoleSession,
  assumeSavedRoleTarget,
  deleteAssumedSession,
  deleteAssumeRoleTarget,
  deleteComparisonPreset,
  getComparisonPreset,
  listIamRoles,
  listComparisonPresets,
  refreshAssumedSession,
  saveComparisonPreset,
  saveAssumeRoleTarget
} from './api'
import { CollapsibleInfoPanel } from './CollapsibleInfoPanel'
import { FreshnessIndicator, useFreshnessState } from './freshness'

type ConnectionState = {
  profile: string
  region: string
  profiles: Array<{ name: string }>
  selectedProfile: { name: string } | null
  connection: AwsConnection | null
  activeSession: AwsSessionSummary | null
  targets: AwsAssumeRoleTarget[]
  sessions: AwsSessionSummary[]
  refreshProfiles: () => Promise<void>
  activateSession: (sessionId: string) => void
  clearActiveSession: () => void
}

function WritableSuggestionField({
  label,
  value,
  placeholder,
  options,
  open,
  emptyLabel,
  loadingLabel,
  onChange,
  onFocus,
  onBlur,
  onSelect
}: {
  label: string
  value: string
  placeholder: string
  options: string[]
  open: boolean
  emptyLabel: string
  loadingLabel?: string
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
  onSelect: (value: string) => void
}) {
  return (
    <label className="field session-hub-picker">
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onFocus}
        onBlur={() => window.setTimeout(onBlur, 120)}
        placeholder={placeholder}
      />
      {open && (
        <div className="session-hub-picker-menu">
          {options.length > 0 ? (
            options.map((option) => (
              <button key={option} type="button" className="session-hub-picker-option" onMouseDown={() => onSelect(option)}>
                {option}
              </button>
            ))
          ) : (
            <div className="session-hub-picker-empty">{loadingLabel || emptyLabel}</div>
          )}
        </div>
      )}
    </label>
  )
}

function emptyDraft(profile: string, region: string): Omit<AwsAssumeRoleTarget, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    label: '',
    roleArn: '',
    defaultSessionName: 'aws-lens',
    externalId: '',
    sourceProfile: profile,
    defaultRegion: region
  }
}

function formatDateTime(value: string): string {
  return value ? new Date(value).toLocaleString() : '-'
}

function formatCountdown(expiration: string): string {
  const remainingMs = new Date(expiration).getTime() - Date.now()
  if (!Number.isFinite(remainingMs)) {
    return '-'
  }
  if (remainingMs <= 0) {
    return 'Expired'
  }

  const totalSeconds = Math.floor(remainingMs / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${hours}h ${minutes}m ${seconds}s`
}

function getExpiryLabel(session: AwsSessionSummary): string {
  if (session.expiryState === 'expired') {
    return 'expired'
  }

  if (session.expiryState === 'expiring') {
    return 'expiring soon'
  }

  return session.status
}

function getSessionStatusClassName(session: AwsSessionSummary): string {
  if (session.expiryState === 'expired') {
    return 'inactive-chip'
  }

  if (session.expiryState === 'expiring') {
    return 'warning-chip'
  }

  return 'active-chip'
}

function buildSessionConnection(session: AwsSessionSummary): AwsConnection {
  return {
    kind: 'assumed-role',
    sessionId: session.id,
    label: session.label,
    profile: session.profile,
    sourceProfile: session.sourceProfile,
    region: session.region,
    roleArn: session.roleArn,
    assumedRoleArn: session.assumedRoleArn,
    accountId: session.accountId,
    accessKeyId: session.accessKeyId,
    expiration: session.expiration,
    externalId: session.externalId
  }
}

export function SessionHub({
  connectionState,
  onOpenCompare,
  onOpenTerminal
}: {
  connectionState: ConnectionState
  onOpenCompare: (request: ComparisonRequest) => void
  onOpenTerminal: (connection: AwsConnection) => void
}) {
  const [draft, setDraft] = useState<Omit<AwsAssumeRoleTarget, 'id' | 'createdAt' | 'updatedAt'>>(
    emptyDraft(connectionState.selectedProfile?.name ?? connectionState.profile, connectionState.region)
  )
  const [editingTargetId, setEditingTargetId] = useState('')
  const [busyId, setBusyId] = useState('')
  const [countdownTick, setCountdownTick] = useState(Date.now())
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [compareLeft, setCompareLeft] = useState('base')
  const [compareRight, setCompareRight] = useState('')
  const [availableRoles, setAvailableRoles] = useState<IamRoleSummary[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [roleArnPickerOpen, setRoleArnPickerOpen] = useState(false)
  const [sourceProfilePickerOpen, setSourceProfilePickerOpen] = useState(false)
  const [comparePresets, setComparePresets] = useState<ComparisonPresetSummary[]>([])
  const [selectedComparePresetId, setSelectedComparePresetId] = useState('')
  const [loadedComparePreset, setLoadedComparePreset] = useState<ComparisonPreset | null>(null)
  const [comparePresetName, setComparePresetName] = useState('')
  const [comparePresetDescription, setComparePresetDescription] = useState('')
  const [comparePresetBusy, setComparePresetBusy] = useState('')
  const [comparePresetMessage, setComparePresetMessage] = useState('')
  const {
    freshness,
    beginRefresh,
    completeRefresh,
    failRefresh
  } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000, initialFetchedAt: Date.now() })

  useEffect(() => {
    const timer = window.setInterval(() => setCountdownTick(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (editingTargetId) {
      return
    }

    setDraft((current) => ({
      ...current,
      sourceProfile: connectionState.selectedProfile?.name || connectionState.profile,
      defaultRegion: connectionState.region
    }))
  }, [connectionState.profile, connectionState.region, connectionState.selectedProfile, editingTargetId])

  const scopedProfileName = connectionState.selectedProfile?.name || connectionState.profile

  const visibleTargets = useMemo(() => {
    if (!scopedProfileName) {
      return []
    }

    return connectionState.targets.filter((target) => target.sourceProfile === scopedProfileName)
  }, [connectionState.targets, scopedProfileName])

  useEffect(() => {
    if (!editingTargetId) {
      return
    }

    const isStillVisible = visibleTargets.some((target) => target.id === editingTargetId)
    if (isStillVisible) {
      return
    }

    setEditingTargetId('')
    setDraft(emptyDraft(scopedProfileName, connectionState.region))
  }, [connectionState.region, editingTargetId, scopedProfileName, visibleTargets])

  const compareOptions = useMemo(() => {
    const options: Array<{
      id: string
      label: string
      requestBase:
        | { kind: 'profile'; profile: string; label?: string }
        | { kind: 'assumed-role'; sessionId: string; label?: string }
        | { kind: 'saved-target'; targetId: string; label?: string }
    }> = []

    for (const profile of connectionState.profiles) {
      options.push({
        id: `profile:${profile.name}`,
        label: `Base profile: ${profile.name}`,
        requestBase: {
          kind: 'profile',
          profile: profile.name,
          label: profile.name
        }
      })
    }

    for (const target of connectionState.targets) {
      options.push({
        id: `target:${target.id}`,
        label: `Saved target: ${target.label} (${target.sourceProfile})`,
        requestBase: {
          kind: 'saved-target',
          targetId: target.id,
          label: target.label
        }
      })
    }

    for (const session of connectionState.sessions.filter((entry) => entry.status === 'active')) {
      options.push({
        id: `session:${session.id}`,
        label: `${session.label} (${session.accountId || 'unknown account'})`,
        requestBase: {
          kind: 'assumed-role',
          sessionId: session.id,
          label: session.label
        }
      })
    }

    return options
  }, [connectionState.profiles, connectionState.sessions, connectionState.targets])

  useEffect(() => {
    const sourceProfile = draft.sourceProfile.trim()
    if (!sourceProfile) {
      setAvailableRoles([])
      return
    }

    const connection: AwsConnection = {
      kind: 'profile',
      sessionId: `profile:${sourceProfile}`,
      label: sourceProfile,
      profile: sourceProfile,
      region: draft.defaultRegion || connectionState.region
    }

    setRolesLoading(true)
    void listIamRoles(connection)
      .then((roles) => setAvailableRoles(roles))
      .catch((err) => {
        setAvailableRoles([])
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setRolesLoading(false))
  }, [connectionState.region, draft.defaultRegion, draft.sourceProfile])

  const roleArnOptions = useMemo(() => {
    const fromAws = availableRoles.map((role) => role.arn)
    const fromSaved = connectionState.targets
      .filter((target) => target.sourceProfile === draft.sourceProfile.trim())
      .map((target) => target.roleArn)
    const query = draft.roleArn.trim().toLowerCase()

    return [...new Set([...fromAws, ...fromSaved].filter(Boolean))]
      .filter((roleArn) => !query || roleArn.toLowerCase().includes(query))
      .sort((a, b) => a.localeCompare(b))
  }, [availableRoles, connectionState.targets, draft.roleArn, draft.sourceProfile])

  const sourceProfileOptions = useMemo(() => {
    const query = draft.sourceProfile.trim().toLowerCase()
    return connectionState.profiles
      .map((profile) => profile.name)
      .filter((name) => !query || name.toLowerCase().includes(query))
      .sort((a, b) => a.localeCompare(b))
  }, [connectionState.profiles, draft.sourceProfile])

  useEffect(() => {
    if (compareLeft === 'base' && compareOptions[0]) {
      setCompareLeft(compareOptions[0].id)
    }
    if (!compareRight && compareOptions[1]) {
      setCompareRight(compareOptions[1].id)
    }
  }, [compareLeft, compareOptions, compareRight])

  useEffect(() => {
    void refreshComparePresets()
  }, [])

  function updateDraft<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]): void {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function refreshSessionHub(): Promise<void> {
    beginRefresh('session')
    try {
      await connectionState.refreshProfiles()
      completeRefresh()
    } catch (error) {
      failRefresh()
      throw error
    }
  }

  async function handleSaveTarget(): Promise<void> {
    setError('')
    setMessage('')
    setBusyId('save-target')

    try {
      await saveAssumeRoleTarget({
        ...draft,
        ...(editingTargetId ? { id: editingTargetId } : {}),
        sourceProfile: draft.sourceProfile || connectionState.profile,
        defaultRegion: draft.defaultRegion || connectionState.region
      })
      setDraft(emptyDraft(connectionState.selectedProfile?.name ?? connectionState.profile, connectionState.region))
      setEditingTargetId('')
      await refreshSessionHub()
      setMessage(editingTargetId ? 'Saved target updated.' : 'Saved target created.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId('')
    }
  }

  async function handleAssume(request: AssumeRoleRequest): Promise<void> {
    setError('')
    setMessage('')
    setBusyId(request.label)

    try {
      const result = await assumeRoleSession(request)
      await refreshSessionHub()
      connectionState.activateSession(result.sessionId)
      setMessage(`Assumed ${result.label}. Temporary credentials are stored in memory only.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId('')
    }
  }

  async function handleAssumeTarget(target: AwsAssumeRoleTarget): Promise<void> {
    setError('')
    setMessage('')
    setBusyId(target.id)

    try {
      const result = target.sourceProfile
        ? await assumeSavedRoleTarget(target.id)
        : await assumeRoleSession({
            label: target.label,
            roleArn: target.roleArn,
            sessionName: target.defaultSessionName,
            externalId: target.externalId || undefined,
            sourceProfile: connectionState.profile || undefined,
            region: target.defaultRegion || connectionState.region
          })

      await refreshSessionHub()
      connectionState.activateSession(result.sessionId)
      setMessage(`Assumed ${result.label}. Temporary credentials are stored in memory only.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId('')
    }
  }

  async function handleRefreshSession(sessionId: string, options?: { activateOnSuccess?: boolean }): Promise<void> {
    setError('')
    setMessage('')
    setBusyId(sessionId)

    try {
      const result = await refreshAssumedSession(sessionId)
      await refreshSessionHub()

      if (options?.activateOnSuccess) {
        connectionState.activateSession(result.sessionId)
      }

      setMessage(`Refreshed ${result.label}. A new temporary session is now available.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId('')
    }
  }

  async function handleRefreshExpiringSessions(): Promise<void> {
    const expiringSessions = connectionState.sessions.filter((session) => session.expiryState === 'expiring')
    if (expiringSessions.length === 0) {
      return
    }

    setError('')
    setMessage('')
    setBusyId('refresh-expiring')

    const activeExpiringSession = connectionState.activeSession
      ? expiringSessions.find((session) => session.id === connectionState.activeSession?.id) ?? null
      : null

    try {
      let refreshedCount = 0
      let activatedSessionId = ''

      for (const session of expiringSessions) {
        const result = await refreshAssumedSession(session.id)
        refreshedCount += 1
        if (activeExpiringSession?.id === session.id) {
          activatedSessionId = result.sessionId
        }
      }

      await refreshSessionHub()
      if (activatedSessionId) {
        connectionState.activateSession(activatedSessionId)
      }

      setMessage(
        refreshedCount === 1
          ? 'Refreshed 1 expiring session.'
          : `Refreshed ${refreshedCount} expiring sessions.`
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId('')
    }
  }

  async function handleDeleteTarget(targetId: string): Promise<void> {
    setError('')
    setMessage('')
    setBusyId(targetId)

    try {
      await deleteAssumeRoleTarget(targetId)
      if (editingTargetId === targetId) {
        setEditingTargetId('')
        setDraft(emptyDraft(connectionState.selectedProfile?.name ?? connectionState.profile, connectionState.region))
      }
      await refreshSessionHub()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId('')
    }
  }

  async function handleDeleteSession(sessionId: string): Promise<void> {
    setError('')
    setMessage('')
    setBusyId(sessionId)

    try {
      await deleteAssumedSession(sessionId)
      if (connectionState.activeSession?.id === sessionId) {
        connectionState.clearActiveSession()
      }
      await refreshSessionHub()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId('')
    }
  }

  function buildCompareRequest(): ComparisonRequest | null {
    const left = compareOptions.find((entry) => entry.id === compareLeft)
    const right = compareOptions.find((entry) => entry.id === compareRight)
    if (!left || !right) {
      return null
    }

    return {
      left: { ...left.requestBase, region: connectionState.region },
      right: { ...right.requestBase, region: connectionState.region }
    }
  }

  function applyCompareRequest(request: ComparisonRequest): void {
    setCompareLeft(
      request.left.kind === 'profile'
        ? `profile:${request.left.profile}`
        : request.left.kind === 'saved-target'
          ? `target:${request.left.targetId}`
          : `session:${request.left.sessionId}`
    )
    setCompareRight(
      request.right.kind === 'profile'
        ? `profile:${request.right.profile}`
        : request.right.kind === 'saved-target'
          ? `target:${request.right.targetId}`
          : `session:${request.right.sessionId}`
    )
  }

  async function refreshComparePresets(): Promise<void> {
    try {
      const next = await listComparisonPresets()
      setComparePresets(next)
      setSelectedComparePresetId((current) => {
        if (current && next.some((preset) => preset.id === current)) return current
        return next[0]?.id ?? ''
      })
    } catch (err) {
      setComparePresetMessage(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleLoadComparePreset(): Promise<void> {
    if (!selectedComparePresetId) {
      return
    }

    setComparePresetBusy('load')
    setComparePresetMessage('')
    try {
      const preset = await getComparisonPreset(selectedComparePresetId)
      if (!preset) {
        setLoadedComparePreset(null)
        setComparePresetMessage('Selected compare preset no longer exists.')
        await refreshComparePresets()
        return
      }

      setLoadedComparePreset(preset)
      setComparePresetName(preset.name)
      setComparePresetDescription(preset.description)
      applyCompareRequest(preset.request)
      setComparePresetMessage(`Loaded compare preset "${preset.name}".`)
    } catch (err) {
      setComparePresetMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setComparePresetBusy('')
    }
  }

  async function handleSaveComparePreset(): Promise<void> {
    const request = buildCompareRequest()
    if (!request) {
      setComparePresetMessage('Choose two contexts before saving a compare preset.')
      return
    }
    if (!comparePresetName.trim()) {
      setComparePresetMessage('Enter a compare preset name.')
      return
    }

    setComparePresetBusy('save')
    setComparePresetMessage('')
    try {
      const summary = await saveComparisonPreset({
        id: loadedComparePreset?.id,
        name: comparePresetName.trim(),
        description: comparePresetDescription.trim(),
        request
      })
      await refreshComparePresets()
      setSelectedComparePresetId(summary.id)
      setLoadedComparePreset(await getComparisonPreset(summary.id))
      setComparePresetMessage(`Saved compare preset "${summary.name}".`)
    } catch (err) {
      setComparePresetMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setComparePresetBusy('')
    }
  }

  async function handleDeleteComparePreset(): Promise<void> {
    if (!selectedComparePresetId) {
      return
    }

    setComparePresetBusy('delete')
    setComparePresetMessage('')
    try {
      await deleteComparisonPreset(selectedComparePresetId)
      if (loadedComparePreset?.id === selectedComparePresetId) {
        setLoadedComparePreset(null)
      }
      setComparePresetName('')
      setComparePresetDescription('')
      await refreshComparePresets()
      setComparePresetMessage('Compare preset deleted.')
    } catch (err) {
      setComparePresetMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setComparePresetBusy('')
    }
  }

  function handleCompareLaunch(): void {
    const request = buildCompareRequest()
    if (!request) {
      setError('Choose two contexts to compare.')
      return
    }

    onOpenCompare(request)
  }

  function loadTargetIntoForm(target: AwsAssumeRoleTarget): void {
    setEditingTargetId(target.id)
    setDraft({
      label: target.label,
      roleArn: target.roleArn,
      defaultSessionName: target.defaultSessionName,
      externalId: target.externalId,
      sourceProfile: target.sourceProfile,
      defaultRegion: target.defaultRegion
    })
  }

  const activeSessionCount = connectionState.sessions.filter((session) => session.status === 'active').length
  const expiredSessionCount = connectionState.sessions.filter((session) => session.status === 'expired').length
  const expiringSessions = connectionState.sessions.filter((session) => session.expiryState === 'expiring')
  const activeExpiringSession = connectionState.activeSession
    ? expiringSessions.find((session) => session.id === connectionState.activeSession?.id) ?? null
    : null
  const currentContextMeta = connectionState.activeSession
    ? connectionState.activeSession.assumedRoleArn || connectionState.activeSession.roleArn
    : connectionState.selectedProfile?.name || connectionState.profile || 'No profile selected'
  void countdownTick

  return (
    <div className="session-hub-shell">
      {message && <div className="empty-state compact">{message}</div>}
      {error && <div className="error-banner">{error}</div>}

      <section className="session-hub-shell-hero">
        <div className="session-hub-shell-hero-copy">
          <div className="eyebrow">Security</div>
          <h2>Cross-Account Session Hub</h2>
          <p>
            Saved role targets persist locally. Temporary credentials stay in memory only and are never written into AWS config or credentials files.
          </p>
          <div className="session-hub-shell-meta-strip">
            <div className="session-hub-shell-meta-pill">
              <span>Context</span>
              <strong>{connectionState.connection?.label ?? 'No active context'}</strong>
            </div>
            <div className="session-hub-shell-meta-pill">
              <span>Mode</span>
              <strong>{connectionState.connection?.kind ?? '-'}</strong>
            </div>
            <div className="session-hub-shell-meta-pill">
              <span>Region</span>
              <strong>{connectionState.connection?.region ?? connectionState.region}</strong>
            </div>
            <div className="session-hub-shell-meta-pill">
              <span>Expires</span>
              <strong>{connectionState.activeSession ? formatCountdown(connectionState.activeSession.expiration) : 'Base profile'}</strong>
            </div>
          </div>
        </div>
        <div className="session-hub-shell-hero-stats">
          <div className="session-hub-shell-stat-card session-hub-shell-stat-card-accent">
            <span>Saved targets</span>
            <strong>{visibleTargets.length}</strong>
            <small>{scopedProfileName || 'No base profile selected'}</small>
          </div>
          <div className="session-hub-shell-stat-card">
            <span>Active sessions</span>
            <strong>{activeSessionCount}</strong>
            <small>{expiredSessionCount} expired retained in memory</small>
          </div>
          <div className="session-hub-shell-stat-card">
            <span>Active account</span>
            <strong>{connectionState.activeSession?.accountId || 'Base'}</strong>
            <small>{connectionState.connection?.region ?? connectionState.region}</small>
          </div>
          <div className="session-hub-shell-stat-card">
            <span>Diff contexts</span>
            <strong>{compareOptions.length}</strong>
            <small>Profiles, saved targets, and sessions available to compare</small>
          </div>
        </div>
      </section>

      <CollapsibleInfoPanel title="Quick Help" className="panel session-hub-compare-panel">
        <div className="empty-state compact session-hub-inline-help">
          Start with a base profile, save repeatable assume-role targets, activate the temporary session you want, then open the terminal or Compare Workspace in that same context. Saved targets persist locally; temporary credentials stay in memory only.
        </div>
      </CollapsibleInfoPanel>

      <div className="session-hub-shell-toolbar">
        <div className="session-hub-toolbar">
          <button
            type="button"
            className="session-hub-toolbar-btn accent"
            onClick={() => {
              const currentConnection = connectionState.connection
              if (currentConnection) {
                onOpenTerminal(currentConnection)
              }
            }}
            disabled={!connectionState.connection}
          >
            Open Terminal
          </button>
          <button
            type="button"
            className="session-hub-toolbar-btn"
            onClick={() => connectionState.clearActiveSession()}
            disabled={!connectionState.activeSession}
          >
            Revert To Base Profile
          </button>
          <button type="button" className="session-hub-toolbar-btn" onClick={() => void refreshSessionHub()}>
            Refresh Sessions
          </button>
          <button
            type="button"
            className="session-hub-toolbar-btn"
            disabled={expiringSessions.length === 0 || busyId === 'refresh-expiring'}
            onClick={() => void handleRefreshExpiringSessions()}
          >
            Refresh Expiring
          </button>
        </div>
        <div className="session-hub-shell-status">
          <div className="session-hub-context-chip">
            <span>Current context</span>
            <strong>{currentContextMeta}</strong>
          </div>
          <FreshnessIndicator freshness={freshness} label="Sessions last refreshed" staleLabel="Session list may be stale" />
        </div>
      </div>

      {expiringSessions.length > 0 && (
        <section className="session-hub-refresh-banner">
          <div>
            <strong>
              {expiringSessions.length === 1
                ? '1 session is expiring soon.'
                : `${expiringSessions.length} sessions are expiring soon.`}
            </strong>
            <p>
              Refresh temporary credentials before terminal, compare, or console actions start failing.
              {activeExpiringSession ? ` Current active context: ${activeExpiringSession.label}.` : ''}
            </p>
          </div>
          <div className="button-row session-hub-toolbar">
            <button
              type="button"
              className="accent"
              disabled={busyId === 'refresh-expiring'}
              onClick={() => void handleRefreshExpiringSessions()}
            >
              Refresh All Expiring
            </button>
            {activeExpiringSession && (
              <button
                type="button"
                disabled={busyId === activeExpiringSession.id}
                onClick={() => void handleRefreshSession(activeExpiringSession.id, { activateOnSuccess: true })}
              >
                Refresh Active Context
              </button>
            )}
          </div>
        </section>
      )}

      <div className="session-hub-main-layout">
        <div className="column stack session-hub-editor-column">
          <div className="panel">
            <div className="panel-header">
              <h3>{editingTargetId ? 'Edit Assume-Role Target' : 'New Assume-Role Target'}</h3>
            </div>
            <div className="session-hub-form-grid">
              <label className="field"><span>Label</span><input value={draft.label} onChange={(event) => updateDraft('label', event.target.value)} /></label>
              <WritableSuggestionField
                label="Role ARN"
                value={draft.roleArn}
                placeholder="Select or paste a role ARN"
                options={roleArnOptions}
                open={roleArnPickerOpen}
                emptyLabel="No role ARNs found for this source profile."
                loadingLabel={rolesLoading ? 'Loading role ARNs...' : undefined}
                onChange={(value) => updateDraft('roleArn', value)}
                onFocus={() => setRoleArnPickerOpen(true)}
                onBlur={() => setRoleArnPickerOpen(false)}
                onSelect={(value) => {
                  updateDraft('roleArn', value)
                  setRoleArnPickerOpen(false)
                }}
              />
              <label className="field"><span>Default Session Name</span><input value={draft.defaultSessionName} onChange={(event) => updateDraft('defaultSessionName', event.target.value)} /></label>
              <label className="field"><span>External ID</span><input value={draft.externalId} onChange={(event) => updateDraft('externalId', event.target.value)} placeholder="Optional" /></label>
              <WritableSuggestionField
                label="Source Profile"
                value={draft.sourceProfile}
                placeholder="Select or type a source profile"
                options={sourceProfileOptions}
                open={sourceProfilePickerOpen}
                emptyLabel="No profiles match."
                onChange={(value) => updateDraft('sourceProfile', value)}
                onFocus={() => setSourceProfilePickerOpen(true)}
                onBlur={() => setSourceProfilePickerOpen(false)}
                onSelect={(value) => {
                  updateDraft('sourceProfile', value)
                  setSourceProfilePickerOpen(false)
                }}
              />
              <label className="field"><span>Default Region</span><input value={draft.defaultRegion} onChange={(event) => updateDraft('defaultRegion', event.target.value)} /></label>
            </div>
            <div className="button-row session-hub-toolbar">
              <button type="button" className="accent" disabled={busyId === 'save-target'} onClick={() => void handleSaveTarget()}>
                {editingTargetId ? 'Save Changes' : 'Save Target'}
              </button>
              <button
                type="button"
                disabled={busyId === draft.label}
                onClick={() => void handleAssume({
                  label: draft.label || draft.roleArn,
                  roleArn: draft.roleArn,
                  sessionName: draft.defaultSessionName,
                  externalId: draft.externalId || undefined,
                  sourceProfile: draft.sourceProfile || undefined,
                  region: draft.defaultRegion || undefined
                })}
              >
                Assume Now
              </button>
              {editingTargetId && (
                <button
                  type="button"
                  onClick={() => {
                    setEditingTargetId('')
                    setDraft(emptyDraft(connectionState.selectedProfile?.name ?? connectionState.profile, connectionState.region))
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="column stack session-hub-target-column">
          <div className="panel">
            <div className="panel-header">
              <h3>Saved Targets</h3>
            </div>
            {visibleTargets.length === 0 ? (
              <div className="empty-state compact">
                {scopedProfileName
                  ? `No saved assume-role targets for ${scopedProfileName} yet.`
                  : 'Select a base profile to view saved assume-role targets.'}
              </div>
            ) : (
              <div className="session-hub-card-list">
                {visibleTargets.map((target) => (
                  <article key={target.id} className="signal-card">
                    <div className="signal-card-header">
                      <div>
                        <strong>{target.label}</strong>
                        <div className="hero-path">{target.roleArn}</div>
                      </div>
                    </div>
                    <div className="hero-path">Profile: {target.sourceProfile || '-'} · Region: {target.defaultRegion || '-'}</div>
                    <div className="button-row session-hub-toolbar">
                      <button type="button" className="accent" disabled={busyId === target.id} onClick={() => void handleAssumeTarget(target)}>Assume</button>
                      <button type="button" onClick={() => loadTargetIntoForm(target)}>Edit</button>
                      <button type="button" className="danger" disabled={busyId === target.id} onClick={() => void handleDeleteTarget(target.id)}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="overview-section-title">Assumed Sessions</div>
      <section className="panel session-hub-sessions-panel">
        {connectionState.sessions.length === 0 ? (
          <div className="empty-state compact">No assumed sessions in memory.</div>
        ) : (
          <div className="table-grid session-hub-session-table">
            <div className="table-row table-head session-hub-session-grid">
              <div>Session</div>
              <div>Status</div>
              <div>Account</div>
              <div>Access Key</div>
              <div>Expiration</div>
              <div>Actions</div>
            </div>
            {connectionState.sessions.map((session) => (
              <div key={session.id} className="table-row session-hub-session-grid session-hub-session-row">
                <div>
                  <strong>{session.label}</strong>
                  <div className="hero-path">{session.assumedRoleArn || session.roleArn}</div>
                  <div className="hero-path">Source: {session.sourceProfile || '-'} · {session.region}</div>
                </div>
                <div>
                  <span className={getSessionStatusClassName(session)}>{getExpiryLabel(session)}</span>
                </div>
                <div>{session.accountId || '-'}</div>
                <div className="mono">{session.accessKeyId || '-'}</div>
                <div>
                  <div>{formatDateTime(session.expiration)}</div>
                  <div className="hero-path">{formatCountdown(session.expiration)}</div>
                </div>
                <div className="session-hub-action-stack">
                  <button type="button" disabled={session.status !== 'active'} onClick={() => connectionState.activateSession(session.id)}>Activate</button>
                  <button type="button" disabled={session.status !== 'active'} onClick={() => onOpenTerminal(buildSessionConnection(session))}>Terminal</button>
                  <button
                    type="button"
                    disabled={busyId === session.id}
                    onClick={() => void handleRefreshSession(session.id, { activateOnSuccess: connectionState.activeSession?.id === session.id })}
                  >
                    {session.expiryState === 'expiring' ? 'Refresh Now' : 'Re-Assume'}
                  </button>
                  <button type="button" className="danger" disabled={busyId === session.id} onClick={() => void handleDeleteSession(session.id)}>Forget</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="overview-section-title">Account Comparison</div>
      <section className="panel session-hub-compare-panel">
        <div className="panel-header">
          <h3>Launch Diff Mode</h3>
        </div>
        <div className="session-hub-form-grid">
          <label className="field">
            <span>Left Context</span>
            <select value={compareLeft} onChange={(event) => setCompareLeft(event.target.value)}>
              {compareOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Right Context</span>
            <select value={compareRight} onChange={(event) => setCompareRight(event.target.value)}>
              <option value="">Select...</option>
              {compareOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Saved Preset</span>
            <select value={selectedComparePresetId} onChange={(event) => setSelectedComparePresetId(event.target.value)}>
              <option value="">Select...</option>
              {comparePresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} ({preset.leftLabel} vs {preset.rightLabel})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Preset Name</span>
            <input
              value={comparePresetName}
              onChange={(event) => setComparePresetName(event.target.value)}
              placeholder="Prod vs staging"
            />
          </label>
          <label className="field session-hub-compare-description">
            <span>Preset Description</span>
            <input
              value={comparePresetDescription}
              onChange={(event) => setComparePresetDescription(event.target.value)}
              placeholder="Optional note for this reusable compare pair"
            />
          </label>
        </div>
        <div className="button-row session-hub-toolbar">
          <button
            type="button"
            disabled={!selectedComparePresetId || comparePresetBusy === 'load'}
            onClick={() => void handleLoadComparePreset()}
          >
            {comparePresetBusy === 'load' ? 'Loading...' : 'Load Preset'}
          </button>
          <button
            type="button"
            disabled={comparePresetBusy === 'save'}
            onClick={() => void handleSaveComparePreset()}
          >
            {comparePresetBusy === 'save' ? 'Saving...' : loadedComparePreset ? 'Update Preset' : 'Save Preset'}
          </button>
          <button
            type="button"
            disabled={!selectedComparePresetId || comparePresetBusy === 'delete'}
            onClick={() => void handleDeleteComparePreset()}
          >
            {comparePresetBusy === 'delete' ? 'Deleting...' : 'Delete Preset'}
          </button>
          <button type="button" className="accent" onClick={handleCompareLaunch}>
            Open Compare Workspace
          </button>
        </div>
        {comparePresetMessage && <div className="empty-state compact">{comparePresetMessage}</div>}
        <div className="empty-state compact">Diff Mode opens a dedicated workspace with inventory, posture, ownership, cost, and risk-focused comparisons.</div>
      </section>

      <CollapsibleInfoPanel title="Recommended Next Actions" className="panel session-hub-compare-panel">
        <div className="info-card-grid info-card-grid-3">
          <article className="info-card">
            <div className="info-card__copy">
              <strong>Validate credentials in the terminal</strong>
              <p>Open a shell in the current base profile or assumed session when you need to confirm identity, CLI auth, or quick AWS commands.</p>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="accent"
                disabled={!connectionState.connection}
                onClick={() => {
                  const currentConnection = connectionState.connection
                  if (currentConnection) {
                    onOpenTerminal(currentConnection)
                  }
                }}
              >
                Open Terminal
              </button>
            </div>
          </article>

          <article className="info-card">
            <div className="info-card__copy">
              <strong>Compare two active contexts</strong>
              <p>Use Diff Mode when you need to inspect inventory, posture, or ownership differences across profiles or assumed-role sessions.</p>
            </div>
            <div className="button-row">
              <button type="button" className="accent" onClick={handleCompareLaunch}>
                Open Compare Workspace
              </button>
            </div>
          </article>

          <article className="info-card">
            <div className="info-card__copy">
              <strong>Revert back to the base profile</strong>
              <p>Drop the temporary assumed-role context before switching to broad inventory browsing or before handing the machine to another operator.</p>
            </div>
            <div className="button-row">
              <button type="button" disabled={!connectionState.activeSession} onClick={() => connectionState.clearActiveSession()}>
                Revert To Base Profile
              </button>
            </div>
          </article>
        </div>
      </CollapsibleInfoPanel>

      <CollapsibleInfoPanel title="Example Workflows" className="panel session-hub-compare-panel">
        <div className="info-card-grid info-card-grid-3">
          <article className="info-card">
            <div className="info-card__copy">
              <strong>Cross-account production inspection</strong>
              <p>Select a base profile, assume a production read role, inspect inventory, then revert back to the base profile when the review is finished.</p>
            </div>
          </article>
          <article className="info-card">
            <div className="info-card__copy">
              <strong>Compare staging and production posture</strong>
              <p>Assume or activate both contexts, launch Compare Workspace, and inspect posture or ownership differences without rewriting local AWS config.</p>
            </div>
          </article>
          <article className="info-card">
            <div className="info-card__copy">
              <strong>Validate an assumed role in the terminal</strong>
              <p>Open a shell from the active session to run `aws sts get-caller-identity`, targeted CLI checks, or emergency diagnostics in the same temporary context.</p>
            </div>
          </article>
        </div>
      </CollapsibleInfoPanel>
    </div>
  )
}
