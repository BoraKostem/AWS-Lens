import { useMemo, useState } from 'react'
import './observability-lab.css'

import type { CorrelatedSignalReference, GeneratedArtifact, ObservabilityPostureReport } from '@shared/types'

function labelTone(tone: string): string {
  if (tone === 'good') return 'good'
  if (tone === 'weak') return 'weak'
  return 'mixed'
}

function artifactBadge(type: GeneratedArtifact['type']): string {
  return type.replace(/-/g, ' ')
}

export function ObservabilityResilienceLab({
  report,
  loading,
  error,
  onRefresh,
  onRunArtifact,
  onNavigateSignal
}: {
  report: ObservabilityPostureReport | null
  loading: boolean
  error: string
  onRefresh: () => void
  onRunArtifact?: (artifact: GeneratedArtifact) => void
  onNavigateSignal?: (signal: CorrelatedSignalReference) => void
}) {
  const [copiedId, setCopiedId] = useState('')
  const scopeLabel = useMemo(() => {
    if (!report) return ''
    if (report.scope.kind === 'eks') return `EKS / ${report.scope.clusterName}`
    if (report.scope.kind === 'ecs') return `ECS / ${report.scope.serviceName}`
    return `Terraform / ${report.scope.projectName}`
  }, [report])

  async function copyText(id: string, content: string) {
    await navigator.clipboard.writeText(content)
    setCopiedId(id)
    window.setTimeout(() => setCopiedId((current) => (current === id ? '' : current)), 1200)
  }

  return (
    <div className="obs-lab">
      <div className="obs-lab-header">
        <div>
          <h3>Observability &amp; Resilience Lab</h3>
          <div className="obs-lab-scope">{scopeLabel || 'Select a scope to analyze'}</div>
        </div>
        <button type="button" className="obs-lab-refresh" onClick={onRefresh} disabled={loading}>
          {loading ? 'Analyzing...' : 'Refresh Analysis'}
        </button>
      </div>

      <div className="obs-lab-beta">
        Beta: this feature may not work as expected.
      </div>

      {error && <div className="obs-lab-error">{error}</div>}
      {!report && !loading && !error && <div className="obs-lab-empty">No report loaded yet.</div>}

      {report && (
        <>
          <div className="obs-lab-section">
            <div className="obs-lab-section-title">Posture Summary</div>
            <div className="obs-lab-summary-grid">
              {report.summary.map((item) => (
                <div key={item.id} className={`obs-lab-summary-card ${labelTone(item.tone)}`}>
                  <div className="obs-lab-summary-top">
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                  <div className="obs-lab-summary-detail">{item.detail}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="obs-lab-section">
            <div className="obs-lab-section-title">Findings</div>
            <div className="obs-lab-list">
              {report.findings.map((finding) => (
                <article key={finding.id} className="obs-lab-card">
                  <div className="obs-lab-card-top">
                    <div>
                      <span className={`obs-lab-severity ${finding.severity}`}>{finding.severity}</span>
                      <h4>{finding.title}</h4>
                    </div>
                    <span className="obs-lab-category">{finding.category}</span>
                  </div>
                  <p>{finding.summary}</p>
                  <div className="obs-lab-detail">{finding.detail}</div>
                  <div className="obs-lab-meta"><strong>Impact:</strong> {finding.impact}</div>
                  {finding.inference && <div className="obs-lab-note">Inference: derived from visible signals, not proven ground truth.</div>}
                  <ul className="obs-lab-evidence">
                    {finding.evidence.map((item, index) => <li key={`${finding.id}-${index}`}>{item}</li>)}
                  </ul>
                </article>
              ))}
            </div>
          </div>

          <div className="obs-lab-section">
            <div className="obs-lab-section-title">Recommended Actions</div>
            <div className="obs-lab-list">
              {report.recommendations.map((item) => (
                <article key={item.id} className="obs-lab-card">
                  <div className="obs-lab-card-top">
                    <h4>{item.title}</h4>
                    <span className="obs-lab-type">{item.type}</span>
                  </div>
                  <p>{item.summary}</p>
                  <div className="obs-lab-meta"><strong>Why:</strong> {item.rationale}</div>
                  <div className="obs-lab-meta"><strong>Benefit:</strong> {item.expectedBenefit}</div>
                  <div className="obs-lab-meta"><strong>Risk:</strong> {item.risk}</div>
                  <div className="obs-lab-meta"><strong>Rollback:</strong> {item.rollback}</div>
                  <div className="obs-lab-tags">
                    {item.labels.map((label) => <span key={label} className="obs-lab-tag">{label}</span>)}
                    <span className="obs-lab-tag">Prereq: {item.prerequisiteLevel}</span>
                    <span className="obs-lab-tag">Effort: {item.setupEffort}</span>
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="obs-lab-section">
            <div className="obs-lab-section-title">Generated Artifacts</div>
            <div className="obs-lab-list">
              {report.artifacts.map((artifact) => (
                <article key={artifact.id} className="obs-lab-card">
                  <div className="obs-lab-card-top">
                    <h4>{artifact.title}</h4>
                    <span className="obs-lab-type">{artifactBadge(artifact.type)}</span>
                  </div>
                  <p>{artifact.summary}</p>
                  <pre className="obs-lab-code"><code>{artifact.content}</code></pre>
                  <div className="obs-lab-meta"><strong>Safety:</strong> {artifact.safety}</div>
                  <div className="obs-lab-actions">
                    <button type="button" onClick={() => void copyText(artifact.id, artifact.content)}>
                      {copiedId === artifact.id ? 'Copied' : artifact.copyLabel}
                    </button>
                    {artifact.isRunnable && onRunArtifact && (
                      <button type="button" className="accent" onClick={() => onRunArtifact(artifact)}>
                        {artifact.runLabel}
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="obs-lab-section">
            <div className="obs-lab-section-title">Safety Notes</div>
            <div className="obs-lab-list">
              {report.safetyNotes.map((note) => (
                <article key={note.title} className="obs-lab-card">
                  <h4>{note.title}</h4>
                  <div className="obs-lab-meta"><strong>Blast radius:</strong> {note.blastRadius}</div>
                  <div className="obs-lab-meta"><strong>Prerequisites:</strong> {note.prerequisites.join(', ')}</div>
                  <div className="obs-lab-meta"><strong>Rollback:</strong> {note.rollback}</div>
                </article>
              ))}
            </div>
          </div>

          {report.scope.kind !== 'terraform' && (
            <div className="obs-lab-section">
              <div className="obs-lab-section-title">Correlated Signals</div>
              <div className="obs-lab-list">
                {report.correlatedSignals.map((signal) => (
                  <article key={signal.id} className="obs-lab-card">
                    <div className="obs-lab-card-top">
                      <h4>{signal.title}</h4>
                      <span className="obs-lab-type">{signal.serviceId}</span>
                    </div>
                    <p>{signal.detail}</p>
                    {onNavigateSignal && (
                      <div className="obs-lab-actions">
                        <button type="button" onClick={() => onNavigateSignal(signal)}>Open {signal.targetView}</button>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
