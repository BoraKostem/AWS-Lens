import { useEffect, useMemo, useState } from 'react'

import type { AssumeRoleRequest, AwsAssumeRoleTarget, AwsConnection, AwsSessionSummary, CallerIdentity, IamRoleSummary, OverviewMetrics, OverviewStatistics, RegionMetric } from '@shared/types'
import {
  assumeRoleSession,
  assumeSavedRoleTarget,
  deleteAssumedSession,
  deleteAssumeRoleTarget,
  getCallerIdentity,
  getOverviewMetrics,
  getOverviewStatistics,
  listIamRoles,
  saveAssumeRoleTarget
} from './api'

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

type CompareOption = {
  id: string
  label: string
  connection: AwsConnection
}

type CompareResult = {
  option: CompareOption
  identity: CallerIdentity
  metrics: OverviewMetrics
  regionalMetrics: RegionMetric | null
  statistics: OverviewStatistics
}

const COMPARE_SERVICE_ROWS: Array<{ label: string; key: keyof RegionMetric }> = [
  { label: 'EC2 Instances', key: 'ec2Count' },
  { label: 'Lambda Functions', key: 'lambdaCount' },
  { label: 'EKS Clusters', key: 'eksCount' },
  { label: 'Auto Scaling Groups', key: 'asgCount' },
  { label: 'S3 Buckets', key: 's3Count' },
  { label: 'RDS Databases', key: 'rdsCount' },
  { label: 'CloudFormation Stacks', key: 'cloudformationCount' },
  { label: 'ECR Repositories', key: 'ecrCount' },
  { label: 'ECS Clusters', key: 'ecsCount' },
  { label: 'VPCs', key: 'vpcCount' },
  { label: 'Load Balancers', key: 'loadBalancerCount' },
  { label: 'Route53 Zones', key: 'route53Count' },
  { label: 'Security Groups', key: 'securityGroupCount' },
  { label: 'SNS Topics', key: 'snsCount' },
  { label: 'SQS Queues', key: 'sqsCount' },
  { label: 'ACM Certificates', key: 'acmCount' },
  { label: 'KMS Keys', key: 'kmsCount' },
  { label: 'WAF Web ACLs', key: 'wafCount' },
  { label: 'Secrets', key: 'secretsManagerCount' },
  { label: 'Key Pairs', key: 'keyPairCount' },
  { label: 'CloudWatch Assets', key: 'cloudwatchCount' },
  { label: 'CloudTrail Trails', key: 'cloudtrailCount' },
  { label: 'IAM Resources', key: 'iamCount' }
]

function compareValueClass(left: string | number, right: string | number): string {
  return String(left) === String(right) ? 'hero-path' : ''
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
  onOpenTerminal
}: {
  connectionState: ConnectionState
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
  const [compareBusy, setCompareBusy] = useState(false)
  const [compareResults, setCompareResults] = useState<CompareResult[] | null>(null)
  const [availableRoles, setAvailableRoles] = useState<IamRoleSummary[]>([])
  const [rolesLoading, setRolesLoading] = useState(false)
  const [roleArnPickerOpen, setRoleArnPickerOpen] = useState(false)
  const [sourceProfilePickerOpen, setSourceProfilePickerOpen] = useState(false)

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

  const compareOptions = useMemo<CompareOption[]>(() => {
    const options: CompareOption[] = []

    if (connectionState.profile) {
      options.push({
        id: 'base',
        label: `Base profile: ${connectionState.profile}`,
        connection: {
          kind: 'profile',
          sessionId: `profile:${connectionState.profile}`,
          label: connectionState.profile,
          profile: connectionState.profile,
          region: connectionState.region
        }
      })
    }

    for (const session of connectionState.sessions.filter((entry) => entry.status === 'active')) {
      options.push({
        id: `session:${session.id}`,
        label: `${session.label} (${session.accountId || 'unknown account'})`,
        connection: buildSessionConnection(session)
      })
    }

    return options
  }, [connectionState.profile, connectionState.region, connectionState.sessions])

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
      .catch(() => setAvailableRoles([]))
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
    if (!compareRight && compareOptions[1]) {
      setCompareRight(compareOptions[1].id)
    }
  }, [compareOptions, compareRight])

  function updateDraft<K extends keyof typeof draft>(key: K, value: (typeof draft)[K]): void {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  async function refreshSessionHub(): Promise<void> {
    await connectionState.refreshProfiles()
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

  async function handleCompare(): Promise<void> {
    const selected = [compareLeft, compareRight]
      .map((id) => compareOptions.find((entry) => entry.id === id) ?? null)
      .filter((entry): entry is CompareOption => Boolean(entry))

    if (selected.length < 2) {
      setError('Choose two contexts to compare.')
      return
    }

    setCompareBusy(true)
      setError('')

    try {
      const results = await Promise.all(selected.map(async (option) => {
        const [identity, metrics, statistics] = await Promise.all([
          getCallerIdentity(option.connection),
          getOverviewMetrics(option.connection, [option.connection.region]),
          getOverviewStatistics(option.connection)
        ])

        return {
          option,
          identity,
          metrics,
          regionalMetrics: metrics.regions[0] ?? null,
          statistics
        }
      }))
      setCompareResults(results)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setCompareResults(null)
    } finally {
      setCompareBusy(false)
    }
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
  const currentContextMeta = connectionState.activeSession
    ? connectionState.activeSession.assumedRoleArn || connectionState.activeSession.roleArn
    : connectionState.selectedProfile?.name || connectionState.profile || 'No profile selected'
  const comparePairs = compareResults && compareResults.length === 2 ? compareResults : null
  const compareSummaryRows = comparePairs ? [
    { label: 'Account', left: comparePairs[0].identity.account || '-', right: comparePairs[1].identity.account || '-' },
    { label: 'ARN', left: comparePairs[0].identity.arn || '-', right: comparePairs[1].identity.arn || '-' },
    { label: 'Region', left: comparePairs[0].option.connection.region || '-', right: comparePairs[1].option.connection.region || '-' },
    { label: 'Monthly Cost', left: comparePairs[0].metrics.globalTotals.totalCost, right: comparePairs[1].metrics.globalTotals.totalCost },
    { label: 'Total Resources', left: comparePairs[0].metrics.globalTotals.totalResources, right: comparePairs[1].metrics.globalTotals.totalResources },
    { label: 'Insights', left: comparePairs[0].statistics.insights.length, right: comparePairs[1].statistics.insights.length },
    { label: 'Signals', left: comparePairs[0].statistics.signals.length, right: comparePairs[1].statistics.signals.length },
    { label: 'Service Stats', left: comparePairs[0].statistics.stats.length, right: comparePairs[1].statistics.stats.length }
  ] : []
  void countdownTick

  return (
    <>
      {message && <div className="empty-state compact">{message}</div>}
      {error && <div className="error-banner">{error}</div>}

      <section className="hero catalog-hero session-hub-hero">
        <div>
          <div className="eyebrow">Security</div>
          <h2>Cross-Account Session Hub</h2>
          <p className="hero-path">
            Saved role targets persist locally. Temporary credentials stay in memory only and are never written into AWS config or credentials files.
          </p>
        </div>
        <div className="hero-connection">
          <div className="connection-summary">
            <span>Current Context</span>
            <strong>{connectionState.connection?.label ?? 'None'}</strong>
          </div>
          <div className="connection-summary">
            <span>Mode</span>
            <strong>{connectionState.connection?.kind ?? '-'}</strong>
          </div>
          <div className="connection-summary">
            <span>Region</span>
            <strong>{connectionState.connection?.region ?? '-'}</strong>
          </div>
          <div className="connection-summary">
            <span>Expires</span>
            <strong>{connectionState.activeSession ? formatCountdown(connectionState.activeSession.expiration) : 'Base profile'}</strong>
          </div>
        </div>
      </section>

      <section className="overview-tiles session-hub-tiles">
        <div className="overview-tile highlight">
          <strong>{visibleTargets.length}</strong>
          <span>Saved Targets</span>
        </div>
        <div className="overview-tile">
          <strong>{activeSessionCount}</strong>
          <span>Active Sessions</span>
        </div>
        <div className="overview-tile">
          <strong>{expiredSessionCount}</strong>
          <span>Expired Sessions</span>
        </div>
        <div className="overview-tile">
          <strong>{connectionState.activeSession?.accountId || 'Base'}</strong>
          <span>Active Account</span>
        </div>
        <div className="overview-tile">
          <strong>{connectionState.connection?.region ?? '-'}</strong>
          <span>Context Region</span>
        </div>
      </section>

      <div className="overview-bottom-row">
        <span>Current context: <strong>{currentContextMeta}</strong></span>
        {connectionState.connection && (
          <button type="button" className="accent" onClick={() => {
            const currentConnection = connectionState.connection
            if (currentConnection) {
              onOpenTerminal(currentConnection)
            }
          }}>
            Open Terminal
          </button>
        )}
        {connectionState.activeSession && (
          <button type="button" onClick={() => connectionState.clearActiveSession()}>
            Revert To Base Profile
          </button>
        )}
        <button type="button" onClick={() => void refreshSessionHub()}>
          Refresh
        </button>
      </div>

      <div className="overview-section-title">Saved Targets</div>
      <section className="workspace-grid">
        <div className="column stack">
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

        <div className="column stack">
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
      </section>

      <div className="overview-section-title">Assumed Sessions</div>
      <section className="panel">
        {connectionState.sessions.length === 0 ? (
          <div className="empty-state compact">No assumed sessions in memory.</div>
        ) : (
          <div className="table-grid">
            <div className="table-row table-head session-hub-session-grid">
              <div>Session</div>
              <div>Status</div>
              <div>Account</div>
              <div>Access Key</div>
              <div>Expiration</div>
              <div>Actions</div>
            </div>
            {connectionState.sessions.map((session) => (
              <div key={session.id} className="table-row session-hub-session-grid">
                <div>
                  <strong>{session.label}</strong>
                  <div className="hero-path">{session.assumedRoleArn || session.roleArn}</div>
                  <div className="hero-path">Source: {session.sourceProfile || '-'} · {session.region}</div>
                </div>
                <div>
                  <span className={session.status === 'active' ? 'active-chip' : 'inactive-chip'}>{session.status}</span>
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
                    onClick={() => void handleAssume({
                      label: session.label,
                      roleArn: session.roleArn,
                      sessionName: session.label.replace(/\s+/g, '-').toLowerCase(),
                      externalId: session.externalId || undefined,
                      sourceProfile: session.sourceProfile || undefined,
                      region: session.region
                    })}
                  >
                    Re-Assume
                  </button>
                  <button type="button" className="danger" disabled={busyId === session.id} onClick={() => void handleDeleteSession(session.id)}>Forget</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="overview-section-title">Account Comparison</div>
      <section className="panel">
        <div className="panel-header">
          <h3>Compare Contexts</h3>
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
        </div>
        <div className="button-row session-hub-toolbar">
          <button type="button" className="accent" disabled={compareBusy} onClick={() => void handleCompare()}>
            {compareBusy ? 'Comparing...' : 'Compare'}
          </button>
        </div>
      </section>

      {comparePairs ? (
        <section className="workspace-grid session-hub-compare-layout">
          <div className="column stack">
            <div className="panel">
              <div className="panel-header">
                <h3>Context Summary</h3>
              </div>
              <div className="table-grid">
                <div className="table-row table-head session-hub-compare-table">
                  <div>Metric</div>
                  <div>{comparePairs[0].option.label}</div>
                  <div>{comparePairs[1].option.label}</div>
                </div>
                {compareSummaryRows.map((row) => (
                  <div key={row.label} className="table-row session-hub-compare-table">
                    <div>{row.label}</div>
                    <div className={`session-hub-compare-cell ${compareValueClass(row.left, row.right)}`}>{String(row.left)}</div>
                    <div className={`session-hub-compare-cell ${compareValueClass(row.right, row.left)}`}>{String(row.right)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="column stack">
            <div className="panel">
              <div className="panel-header">
                <h3>Service Inventory Comparison</h3>
              </div>
              <div className="table-grid">
                <div className="table-row table-head session-hub-compare-table">
                  <div>Service</div>
                  <div>{comparePairs[0].option.label}</div>
                  <div>{comparePairs[1].option.label}</div>
                </div>
                {COMPARE_SERVICE_ROWS.map((row) => (
                  <div key={row.label} className="table-row session-hub-compare-table">
                    <div>{row.label}</div>
                    <div className={`session-hub-compare-cell ${compareValueClass(comparePairs[0].regionalMetrics?.[row.key] ?? '-', comparePairs[1].regionalMetrics?.[row.key] ?? '-')}`}>
                      {String(comparePairs[0].regionalMetrics?.[row.key] ?? '-')}
                    </div>
                    <div className={`session-hub-compare-cell ${compareValueClass(comparePairs[1].regionalMetrics?.[row.key] ?? '-', comparePairs[0].regionalMetrics?.[row.key] ?? '-')}`}>
                      {String(comparePairs[1].regionalMetrics?.[row.key] ?? '-')}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="empty-state compact">Select two contexts to compare summary totals and full regional inventory.</div>
        </section>
      )}
    </>
  )
}
