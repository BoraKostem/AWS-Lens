import { useMemo } from 'react'

import type { ProviderPermissionDiagnosticsReport } from './providerPermissionDiagnostics'

function toneForStatus(status: 'ok' | 'warning' | 'error'): 'stable' | 'preview' | 'unknown' {
  return status === 'ok' ? 'stable' : status === 'error' ? 'preview' : 'unknown'
}

export function ProviderPermissionDiagnosticsPanel({
  report,
  title = 'Permission Diagnostics',
  compact = false
}: {
  report: ProviderPermissionDiagnosticsReport
  title?: string
  compact?: boolean
}): JSX.Element {
  const readyItems = useMemo(() => report.items.filter((item) => item.status === 'ok'), [report.items])
  const attentionItems = useMemo(() => report.items.filter((item) => item.status !== 'ok'), [report.items])

  return (
    <section className={`provider-diagnostics-shell provider-diagnostics-shell-${report.providerId} ${compact ? 'compact' : ''}`}>
      <div className="provider-diagnostics-header">
        <div>
          <div className="eyebrow">{title}</div>
          <h3>{report.providerLabel} permission posture</h3>
          <p className="hero-path">{report.summary}</p>
        </div>
        <div className="provider-diagnostics-summary">
          <span className="provider-diagnostics-summary__chip">{report.providerLabel}</span>
          <strong>{attentionItems.length}</strong>
          <small>{attentionItems.length === 1 ? 'item needs attention' : 'items need attention'}</small>
        </div>
      </div>
      <div className="provider-diagnostics-grid">
        <section className="provider-diagnostics-column">
          <div className="eyebrow">Ready</div>
          {readyItems.length > 0 ? (
            readyItems.map((item) => (
              <div key={item.id} className="settings-environment-row provider-diagnostics-row">
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.detail}</p>
                </div>
                <div className="settings-environment-meta">
                  <span className={`settings-status-pill settings-status-pill-${toneForStatus(item.status)}`}>{item.status}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="settings-static-muted">No checks are fully ready for this provider yet.</div>
          )}
        </section>
        <section className="provider-diagnostics-column">
          <div className="eyebrow">Needs Attention</div>
          {attentionItems.length > 0 ? (
            attentionItems.map((item) => (
              <div key={item.id} className="settings-environment-row provider-diagnostics-row">
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.detail}</p>
                  {item.remediation && <small>{item.remediation}</small>}
                </div>
                <div className="settings-environment-meta">
                  <span className={`settings-status-pill settings-status-pill-${toneForStatus(item.status)}`}>{item.status}</span>
                </div>
              </div>
            ))
          ) : (
            <div className="settings-static-muted">Nothing currently needs attention.</div>
          )}
        </section>
      </div>
    </section>
  )
}
