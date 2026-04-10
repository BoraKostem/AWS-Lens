import { useEffect, useMemo, useState } from 'react'

import { assumeRole, decodeAuthorizationMessage, getAssumedSessionCredentials, getCallerIdentity, lookupAccessKeyOwnership } from './api'
import type { AccessKeyOwnership, AssumeRoleResult, AwsConnection, CallerIdentity } from '@shared/types'
import './sts.css'

type StsAction = 'identity' | 'decode' | 'lookup' | 'assume' | null

function formatRelativeExpiry(value: string): string {
  if (!value) return 'No expiry reported'

  const expiresAt = new Date(value).getTime()
  if (Number.isNaN(expiresAt)) return value

  const diffMs = expiresAt - Date.now()
  const diffMinutes = Math.round(diffMs / 60000)

  if (diffMinutes <= 0) return 'Expired'
  if (diffMinutes < 60) return `Expires in ${diffMinutes} min`

  const diffHours = Math.round((diffMinutes / 60) * 10) / 10
  if (diffHours < 24) return `Expires in ${diffHours} hr`

  const diffDays = Math.round((diffHours / 24) * 10) / 10
  return `Expires in ${diffDays} days`
}

function formatDateTime(value: string): string {
  if (!value) return '-'

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value

  return parsed.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function maskSecret(value: string, keep = 4): string {
  if (!value) return '-'
  if (value.length <= keep * 2) return value
  return `${value.slice(0, keep)}...${value.slice(-keep)}`
}

export function StsConsole({ connection }: { connection: AwsConnection }) {
  const [identity, setIdentity] = useState<CallerIdentity | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [activeAction, setActiveAction] = useState<StsAction>(null)

  const [encodedMessage, setEncodedMessage] = useState('')
  const [decodedMessage, setDecodedMessage] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [ownership, setOwnership] = useState<AccessKeyOwnership | null>(null)
  const [roleArn, setRoleArn] = useState('')
  const [sessionName, setSessionName] = useState('infra-lens-session')
  const [externalId, setExternalId] = useState('')
  const [assumed, setAssumed] = useState<AssumeRoleResult | null>(null)
  const [assumedSecrets, setAssumedSecrets] = useState<{ secretAccessKey: string; sessionToken: string } | null>(null)

  async function loadIdentity() {
    setError('')
    setActiveAction('identity')
    try {
      const id = await getCallerIdentity(connection)
      setIdentity(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActiveAction(null)
    }
  }

  useEffect(() => { void loadIdentity() }, [connection.sessionId, connection.region])

  const summaryStats = useMemo(() => {
    const principalType = identity?.arn?.split(':').at(-1)?.split('/')[0] || 'Unknown principal'
    const identityState = identity ? 'Resolved' : activeAction === 'identity' ? 'Loading' : 'Unavailable'
    const keyLookupState = ownership ? 'Matched' : accessKeyId ? 'Ready to inspect' : 'Awaiting input'
    const sessionState = assumed ? formatRelativeExpiry(assumed.expiration) : 'No session assumed'

    return [
      {
        label: 'Identity State',
        value: identityState,
        detail: identity?.account ? `Account ${identity.account}` : 'Fetches caller identity for the active session.'
      },
      {
        label: 'Principal Type',
        value: principalType,
        detail: identity?.arn || 'Derived from the current ARN.'
      },
      {
        label: 'Access Key Check',
        value: keyLookupState,
        detail: ownership?.arn || 'Trace an access key back to its owning principal.'
      },
      {
        label: 'Session Status',
        value: sessionState,
        detail: assumed ? formatDateTime(assumed.expiration) : 'AssumeRole output remains local to this page.'
      }
    ]
  }, [accessKeyId, activeAction, assumed, identity, ownership])

  async function handleDecode() {
    setError('')
    setMsg('')
    setActiveAction('decode')

    try {
      const result = await decodeAuthorizationMessage(connection, encodedMessage)
      setDecodedMessage(result.decodedMessage)
      setMsg('Decoded authorization message.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActiveAction(null)
    }
  }

  async function handleLookupOwnership() {
    setError('')
    setMsg('')
    setActiveAction('lookup')

    try {
      const result = await lookupAccessKeyOwnership(connection, accessKeyId)
      setOwnership(result)
      setMsg('Resolved access key ownership.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActiveAction(null)
    }
  }

  async function handleAssumeRole() {
    setError('')
    setMsg('')
    setActiveAction('assume')

    try {
      const result = await assumeRole(connection, roleArn, sessionName, externalId || undefined)
      setAssumed(result)
      setMsg('Role assumed successfully.')
      // Fetch sensitive credentials separately to avoid caching them in the main result
      try {
        const secrets = await getAssumedSessionCredentials(result.sessionId)
        setAssumedSecrets(secrets)
      } catch {
        setAssumedSecrets(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setActiveAction(null)
    }
  }

  return (
    <div className="svc-console sts-console">
      <section className="sts-hero">
        <div className="sts-hero-copy">
          <span className="sts-eyebrow">Security Token Service</span>
          <h2>Inspect the active caller, decode denied requests, and mint short-lived role sessions.</h2>
          <p>
            The workflow mirrors the Terraform pages: high-signal status first, operational tools second, and detailed
            outputs kept close to the action that produced them.
          </p>
          <div className="sts-meta-strip">
            <div className="sts-meta-pill">
              <span>Session</span>
              <strong>{connection.sessionId || 'Direct credentials'}</strong>
            </div>
            <div className="sts-meta-pill">
              <span>Region</span>
              <strong>{connection.region}</strong>
            </div>
            <div className="sts-meta-pill">
              <span>Last Assumed Role</span>
              <strong>{assumed?.roleArn || 'No assumed session yet'}</strong>
            </div>
          </div>
        </div>

        <div className="sts-hero-stats" aria-label="STS summary">
          {summaryStats.map((stat, index) => (
            <article
              key={stat.label}
              className={`sts-stat-card${index === 0 ? ' sts-stat-card-accent' : ''}`}
            >
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
              <small>{stat.detail}</small>
            </article>
          ))}
        </div>
      </section>

      <div className="sts-toolbar">
        <div className="sts-toolbar-copy">
          <span className="sts-eyebrow">Workspace</span>
          <strong>Identity diagnostics</strong>
          <small>All actions continue to use the existing STS service calls and local result rendering.</small>
        </div>
        <button className="svc-btn primary" type="button" onClick={() => void loadIdentity()} disabled={activeAction === 'identity'}>
          {activeAction === 'identity' ? 'Refreshing...' : 'Refresh identity'}
        </button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      <div className="sts-grid">
        <section className="svc-panel sts-panel sts-panel-identity">
          <div className="sts-panel-header">
            <div>
              <span className="sts-panel-kicker">Current session</span>
              <h3>Caller identity</h3>
            </div>
            <small>Confirms the account, ARN, and principal backing this renderer session.</small>
          </div>
          {identity ? (
            <div className="svc-kv sts-kv">
              <div className="svc-kv-row"><div className="svc-kv-label">Account</div><div className="svc-kv-value">{identity.account}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value">{identity.arn}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">User ID</div><div className="svc-kv-value">{identity.userId}</div></div>
            </div>
          ) : (
            <p className="sts-empty-copy">Run a refresh to load the identity bound to the current AWS connection.</p>
          )}
        </section>

        <section className="svc-panel sts-panel">
          <div className="sts-panel-header">
            <div>
              <span className="sts-panel-kicker">Policy analysis</span>
              <h3>Decode authorization message</h3>
            </div>
            <small>Turn the encoded denial payload into readable IAM evaluation details.</small>
          </div>
          <label className="sts-field">
            <span>Encoded message</span>
            <textarea
              value={encodedMessage}
              onChange={e => setEncodedMessage(e.target.value)}
              placeholder="Paste the encoded authorization failure message."
            />
          </label>
          <div className="svc-btn-row">
            <button
              type="button"
              className="svc-btn primary"
              onClick={() => void handleDecode()}
              disabled={!encodedMessage.trim() || activeAction === 'decode'}
            >
              {activeAction === 'decode' ? 'Decoding...' : 'Decode message'}
            </button>
          </div>
          {decodedMessage && <pre className="svc-code sts-code">{decodedMessage}</pre>}
        </section>

        <section className="svc-panel sts-panel">
          <div className="sts-panel-header">
            <div>
              <span className="sts-panel-kicker">Forensics</span>
              <h3>Access key ownership</h3>
            </div>
            <small>Trace a key ID back to the owning account and principal.</small>
          </div>
          <div className="sts-inline-form">
            <input
              placeholder="AKIA..."
              value={accessKeyId}
              onChange={e => setAccessKeyId(e.target.value)}
            />
            <button
              type="button"
              className="svc-btn primary"
              onClick={() => void handleLookupOwnership()}
              disabled={!accessKeyId.trim() || activeAction === 'lookup'}
            >
              {activeAction === 'lookup' ? 'Looking up...' : 'Lookup owner'}
            </button>
          </div>
          {ownership ? (
            <div className="svc-kv sts-kv">
              <div className="svc-kv-row"><div className="svc-kv-label">User ID</div><div className="svc-kv-value">{ownership.userId}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">Account</div><div className="svc-kv-value">{ownership.account}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value">{ownership.arn}</div></div>
            </div>
          ) : (
            <p className="sts-empty-copy">Enter an access key ID to resolve the owning principal.</p>
          )}
        </section>

        <section className="svc-panel sts-panel sts-panel-assume">
          <div className="sts-panel-header">
            <div>
              <span className="sts-panel-kicker">Session minting</span>
              <h3>Assume role</h3>
            </div>
            <small>Generate a short-lived role session while keeping credential output readable.</small>
          </div>
          <div className="sts-form-grid">
            <label className="sts-field">
              <span>Role ARN</span>
              <input value={roleArn} onChange={e => setRoleArn(e.target.value)} placeholder="arn:aws:iam::123456789012:role/ExampleRole" />
            </label>
            <label className="sts-field">
              <span>Session name</span>
              <input value={sessionName} onChange={e => setSessionName(e.target.value)} />
            </label>
            <label className="sts-field">
              <span>External ID</span>
              <input value={externalId} onChange={e => setExternalId(e.target.value)} placeholder="Optional" />
            </label>
          </div>
          <div className="svc-btn-row">
            <button
              type="button"
              className="svc-btn success"
              onClick={() => void handleAssumeRole()}
              disabled={!roleArn.trim() || !sessionName.trim() || activeAction === 'assume'}
            >
              {activeAction === 'assume' ? 'Assuming role...' : 'Assume role'}
            </button>
          </div>
          {assumed ? (
            <div className="sts-result-stack">
              <div className="sts-result-grid">
                <article className="sts-result-card">
                  <span>Session ID</span>
                  <strong>{assumed.sessionId}</strong>
                  <small>{assumed.label}</small>
                </article>
                <article className="sts-result-card">
                  <span>Account</span>
                  <strong>{assumed.accountId}</strong>
                  <small>{formatRelativeExpiry(assumed.expiration)}</small>
                </article>
                <article className="sts-result-card">
                  <span>Access Key</span>
                  <strong>{maskSecret(assumed.accessKeyId)}</strong>
                  <small>{assumed.region}</small>
                </article>
              </div>
              <div className="svc-kv sts-kv">
                <div className="svc-kv-row"><div className="svc-kv-label">Role ARN</div><div className="svc-kv-value">{assumed.roleArn}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Assumed ARN</div><div className="svc-kv-value">{assumed.assumedRoleArn}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Assumed Role ID</div><div className="svc-kv-value">{assumed.assumedRoleId}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Source Profile</div><div className="svc-kv-value">{assumed.sourceProfile}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Expiration</div><div className="svc-kv-value">{formatDateTime(assumed.expiration)}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Packed Policy Size</div><div className="svc-kv-value">{assumed.packedPolicySize}%</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Secret Access Key</div><div className="svc-kv-value">{maskSecret(assumedSecrets?.secretAccessKey ?? '', 6)}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Session Token</div><div className="svc-kv-value">{maskSecret(assumedSecrets?.sessionToken ?? '', 8)}</div></div>
              </div>
            </div>
          ) : (
            <p className="sts-empty-copy">Enter a role ARN and session name to request temporary credentials.</p>
          )}
        </section>
      </div>
    </div>
  )
}
