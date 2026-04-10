import { useEffect, useMemo, useState } from 'react'

import type { GcpCliConfiguration, GcpCliContext, GcpCliProject } from '@shared/types'
import './gcp-session-hub.css'
import { FreshnessIndicator, useFreshnessState } from './freshness'
import { SvcState } from './SvcState'

function formatProjectLabel(project: GcpCliProject | null, fallbackProjectId: string): string {
  if (!project) {
    return fallbackProjectId || 'No project selected'
  }

  return project.name && project.name !== project.projectId
    ? `${project.name} (${project.projectId})`
    : project.projectId
}

function preferredConfigLocation(configuration: GcpCliConfiguration): string {
  return configuration.zone || configuration.region || ''
}

export function GcpSessionHub({
  modeLabel,
  projectId,
  location,
  credentialHint,
  cliContext,
  catalogProjects,
  recentProjects,
  locationOptions,
  cliBusy,
  cliError,
  refreshNonce = 0,
  canRunTerminalCommand,
  terminalReady,
  onRefreshCatalog,
  onApplyProject,
  onApplyLocation,
  onOpenCompare,
  onOpenCompliance,
  onOpenProjects,
  onOpenLogging,
  onRunTerminalCommand
}: {
  modeLabel: string
  projectId: string
  location: string
  credentialHint: string
  cliContext: GcpCliContext | null
  catalogProjects: GcpCliProject[]
  recentProjects: GcpCliProject[]
  locationOptions: string[]
  cliBusy: boolean
  cliError: string
  refreshNonce?: number
  canRunTerminalCommand: boolean
  terminalReady: boolean
  onRefreshCatalog: () => Promise<void>
  onApplyProject: (projectId: string) => void
  onApplyLocation: (location: string) => void
  onOpenCompare: () => void
  onOpenCompliance: () => void
  onOpenProjects: () => void
  onOpenLogging: () => void
  onRunTerminalCommand: (command: string) => void
}) {
  const [search, setSearch] = useState('')
  const { freshness, beginRefresh, completeRefresh, failRefresh } = useFreshnessState({ staleAfterMs: 2 * 60 * 1000, initialFetchedAt: Date.now() })

  useEffect(() => {
    if (cliContext || refreshNonce > 0) {
      completeRefresh()
    }
  }, [cliContext, completeRefresh, refreshNonce])

  const activeConfiguration = cliContext?.configurations.find((entry) => entry.isActive) ?? cliContext?.configurations[0] ?? null
  const activeProject = useMemo(
    () => catalogProjects.find((entry) => entry.projectId === projectId) ?? catalogProjects.find((entry) => entry.projectId === cliContext?.activeProjectId) ?? null,
    [catalogProjects, cliContext?.activeProjectId, projectId]
  )
  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) {
      return catalogProjects
    }

    return catalogProjects.filter((entry) => [entry.projectId, entry.name, entry.projectNumber, entry.lifecycleState].join(' ').toLowerCase().includes(query))
  }, [catalogProjects, search])
  const terminalActionCount = projectId ? 4 : 2
  const terminalActionDisabled = !canRunTerminalCommand || !terminalReady

  async function handleRefresh(): Promise<void> {
    beginRefresh('manual')
    try {
      await onRefreshCatalog()
      completeRefresh()
    } catch {
      failRefresh()
    }
  }

  function adoptConfiguration(configuration: GcpCliConfiguration): void {
    if (configuration.projectId) {
      onApplyProject(configuration.projectId)
    }

    const nextLocation = preferredConfigLocation(configuration)
    if (nextLocation) {
      onApplyLocation(nextLocation)
    }
  }

  return (
    <div className="stack gcp-session-hub">
      {cliError ? <SvcState variant="error" error={cliError} /> : null}
      {!canRunTerminalCommand ? (
        <div className="error-banner">
          Read mode active. {terminalActionCount} terminal validation and `gcloud` handoff actions are disabled on this screen.
        </div>
      ) : !terminalReady ? (
        <div className="error-banner">
          Terminal context is not ready yet. Select a Google Cloud project and location first so the shared shell can inject the correct `gcloud` environment.
        </div>
      ) : null}

      <section className="tf-shell-hero gcp-session-hero">
        <div className="tf-shell-hero-copy">
          <div className="eyebrow">Sessions</div>
          <h2>Google Cloud session workspace</h2>
          <p>Keep the shared shell aligned with the selected `gcloud` context, recent projects, current location, and next operator handoffs.</p>
          <div className="tf-shell-meta-strip">
            <div className="tf-shell-meta-pill"><span>Project</span><strong>{projectId || cliContext?.activeProjectId || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Location</span><strong>{location || activeConfiguration?.region || activeConfiguration?.zone || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>Mode</span><strong>{modeLabel || 'Not selected'}</strong></div>
            <div className="tf-shell-meta-pill"><span>CLI account</span><strong>{cliContext?.activeAccount || 'Not detected'}</strong></div>
          </div>
        </div>
        <div className="tf-shell-hero-stats">
          <div className="tf-shell-stat-card tf-shell-stat-card-accent"><span>Catalog projects</span><strong>{catalogProjects.length}</strong><small>Imported from the active Google Cloud context</small></div>
          <div className="tf-shell-stat-card"><span>Configurations</span><strong>{cliContext?.configurations.length ?? 0}</strong><small>`gcloud config configurations list` coverage</small></div>
          <div className="tf-shell-stat-card"><span>Recent projects</span><strong>{recentProjects.length}</strong><small>Fast handoff targets for the shared shell</small></div>
          <div className="tf-shell-stat-card"><span>Access mode</span><strong>{canRunTerminalCommand ? 'Operator' : 'Read'}</strong><small>{canRunTerminalCommand ? 'Terminal remediation enabled' : 'Terminal remediation disabled'}</small></div>
        </div>
      </section>

      <div className="tf-shell-toolbar gcp-session-toolbar">
        <div className="tf-toolbar gcp-session-toolbar-main">
          <button type="button" className="accent" onClick={() => void handleRefresh()} disabled={cliBusy}>{cliBusy ? 'Refreshing...' : 'Refresh catalog'}</button>
          <button type="button" onClick={onOpenCompare}>Open Compare</button>
          <button type="button" onClick={onOpenCompliance}>Open Compliance</button>
          <button type="button" onClick={onOpenProjects}>Open Projects</button>
          <button type="button" onClick={onOpenLogging}>Open Logging</button>
          <button type="button" className="ghost" disabled={terminalActionDisabled} onClick={() => onRunTerminalCommand('gcloud config list --format=json')} title={terminalActionDisabled ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a project and location to prepare the terminal context') : 'gcloud config list --format=json'}>Inspect in terminal</button>
        </div>
        <div className="tf-shell-status"><FreshnessIndicator freshness={freshness} label="Session catalog" staleLabel="Refresh catalog" /></div>
      </div>

      {!projectId || !location ? (
        <SvcState variant="empty" message="Select a Google Cloud project and location to complete the shared session context for Compare, Compliance, Direct Access, and terminal flows." />
      ) : null}

      <section className="overview-tiles gcp-session-overview-grid">
        <div className="overview-tile highlight"><strong>{formatProjectLabel(activeProject, projectId || cliContext?.activeProjectId || '')}</strong><span>Active shell project</span></div>
        <div className="overview-tile"><strong>{location || activeConfiguration?.region || activeConfiguration?.zone || '-'}</strong><span>Active shell location</span></div>
        <div className="overview-tile"><strong>{cliContext?.activeConfigurationName || activeConfiguration?.name || '-'}</strong><span>gcloud configuration</span></div>
        <div className="overview-tile"><strong>{credentialHint || cliContext?.activeAccount || '-'}</strong><span>Credential hint</span></div>
      </section>

      <div className="gcp-session-layout">
        <section className="panel stack gcp-session-panel">
          <div className="panel-header">
            <h3>Active Shell Context</h3>
          </div>
          <div className="gcp-session-kv-grid">
            <div className="gcp-session-kv"><span>Project</span><strong>{formatProjectLabel(activeProject, projectId || cliContext?.activeProjectId || '')}</strong></div>
            <div className="gcp-session-kv"><span>Project number</span><strong>{activeProject?.projectNumber || '-'}</strong></div>
            <div className="gcp-session-kv"><span>Lifecycle</span><strong>{activeProject?.lifecycleState || 'Unknown'}</strong></div>
            <div className="gcp-session-kv"><span>CLI account</span><strong>{cliContext?.activeAccount || 'Not detected'}</strong></div>
            <div className="gcp-session-kv"><span>Configuration</span><strong>{cliContext?.activeConfigurationName || activeConfiguration?.name || 'Default'}</strong></div>
            <div className="gcp-session-kv"><span>Credential hint</span><strong>{credentialHint || 'Not set'}</strong></div>
          </div>
          <label className="field gcp-session-field">
            <span>Location</span>
            <select value={location} onChange={(event) => onApplyLocation(event.target.value)} disabled={locationOptions.length === 0}>
              {!location ? <option value="" disabled>{cliBusy ? 'Loading locations...' : 'Select location'}</option> : null}
              {locationOptions.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
            </select>
          </label>
          <div className="gcp-session-action-row">
            <button type="button" disabled={terminalActionDisabled || !projectId} onClick={() => onRunTerminalCommand(`gcloud projects describe ${projectId} --format=json`)} title={terminalActionDisabled || !projectId ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a project and location to prepare the terminal context') : `gcloud projects describe ${projectId} --format=json`}>Describe project</button>
            <button type="button" disabled={terminalActionDisabled} onClick={() => onRunTerminalCommand('gcloud auth list --filter=status:ACTIVE')} title={terminalActionDisabled ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a project and location to prepare the terminal context') : 'gcloud auth list --filter=status:ACTIVE'}>Validate auth</button>
            <button type="button" disabled={terminalActionDisabled || !projectId} onClick={() => onRunTerminalCommand(`gcloud logging read --project ${projectId} --limit=10 --format=json "severity>=ERROR"`)} title={terminalActionDisabled || !projectId ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a project and location to prepare the terminal context') : `gcloud logging read --project ${projectId} --limit=10 --format=json "severity>=ERROR"`}>Read errors</button>
          </div>
        </section>

        <section className="panel stack gcp-session-panel">
          <div className="panel-header">
            <h3>Detected gcloud Configurations</h3>
          </div>
          {!cliContext?.configurations.length ? (
            <SvcState variant="empty" message="No `gcloud` configurations were detected. Refresh the catalog after running `gcloud auth login` or setting up application default credentials." />
          ) : (
            <div className="selection-list gcp-session-selection-list">
              {cliContext.configurations.map((configuration) => {
                const isActive = configuration.isActive
                const configLocation = preferredConfigLocation(configuration)

                return (
                  <article key={configuration.name} className={`selection-item gcp-session-card ${isActive ? 'active' : ''}`}>
                    <div className="gcp-session-card-header">
                      <div>
                        <strong>{configuration.name}</strong>
                        <div className="hero-path"><span>{configuration.account || 'No account'}</span><span>{configuration.projectId || 'No project'}</span></div>
                      </div>
                      <span className={`signal-badge ${isActive ? 'severity-low' : ''}`}>{isActive ? 'active' : 'available'}</span>
                    </div>
                    <div className="gcp-session-config-meta">
                      <span>Region: {configuration.region || '-'}</span>
                      <span>Zone: {configuration.zone || '-'}</span>
                    </div>
                    <div className="gcp-session-card-actions">
                      <button type="button" onClick={() => adoptConfiguration(configuration)} disabled={!configuration.projectId}>Adopt context</button>
                      <button type="button" className="ghost" disabled={terminalActionDisabled} onClick={() => onRunTerminalCommand(`gcloud config configurations activate ${configuration.name}`)} title={terminalActionDisabled ? (!canRunTerminalCommand ? 'Switch to Operator mode to enable terminal actions' : 'Select a project and location to prepare the terminal context') : `gcloud config configurations activate ${configuration.name}`}>Activate in terminal</button>
                      {configLocation ? <button type="button" className="ghost" onClick={() => onApplyLocation(configLocation)}>Use {configLocation}</button> : null}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <section className="panel stack gcp-session-panel">
        <div className="panel-header">
          <h3>Project Handoff Queue</h3>
        </div>
        <div className="gcp-session-project-toolbar">
          <label className="field gcp-session-search">
            <span>Search</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Project id, name, number" />
          </label>
        </div>
        {recentProjects.length ? (
          <div className="gcp-session-recent-row">
            {recentProjects.map((project) => (
              <button key={`recent-${project.projectId}`} type="button" className={`gcp-session-recent-chip ${project.projectId === projectId ? 'active' : ''}`} onClick={() => onApplyProject(project.projectId)}>
                {project.projectId}
              </button>
            ))}
          </div>
        ) : null}
        {!filteredProjects.length ? (
          <SvcState variant="no-filter-matches" resourceName="projects" />
        ) : (
          <div className="gcp-session-project-grid">
            {filteredProjects.slice(0, 12).map((project) => {
              const isSelected = project.projectId === projectId

              return (
                <article key={project.projectId} className={`gcp-session-project-card ${isSelected ? 'active' : ''}`}>
                  <div className="gcp-session-card-header">
                    <div>
                      <strong>{project.name || project.projectId}</strong>
                      <div className="hero-path"><span>{project.projectId}</span><span>{project.projectNumber}</span></div>
                    </div>
                    <span className="signal-badge">{project.lifecycleState}</span>
                  </div>
                  <div className="gcp-session-card-actions">
                    <button type="button" onClick={() => onApplyProject(project.projectId)}>{isSelected ? 'Selected' : 'Use project'}</button>
                    <button type="button" className="ghost" onClick={onOpenProjects}>Open Projects</button>
                    <button type="button" className="ghost" onClick={onOpenCompare}>Compare</button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
