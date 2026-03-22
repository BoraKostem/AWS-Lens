import { useEffect, useState } from 'react'

import { assumeRole, decodeAuthorizationMessage, getCallerIdentity, lookupAccessKeyOwnership } from './api'
import type { AccessKeyOwnership, AssumeRoleResult, AwsConnection, CallerIdentity } from '@shared/types'

export function StsConsole({ connection }: { connection: AwsConnection }) {
  const [identity, setIdentity] = useState<CallerIdentity | null>(null)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const [encodedMessage, setEncodedMessage] = useState('')
  const [decodedMessage, setDecodedMessage] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [ownership, setOwnership] = useState<AccessKeyOwnership | null>(null)
  const [roleArn, setRoleArn] = useState('')
  const [sessionName, setSessionName] = useState('electron-tools')
  const [externalId, setExternalId] = useState('')
  const [assumed, setAssumed] = useState<AssumeRoleResult | null>(null)

  async function loadIdentity() {
    setError('')
    try {
      const id = await getCallerIdentity(connection)
      setIdentity(id)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  useEffect(() => { void loadIdentity() }, [connection.profile, connection.region])

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">STS Tools</button>
        <button className="svc-tab right" type="button" onClick={() => void loadIdentity()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        {/* Caller Identity */}
        <div className="svc-panel">
          <h3>Caller Identity</h3>
          {identity && (
            <div className="svc-kv">
              <div className="svc-kv-row"><div className="svc-kv-label">Account</div><div className="svc-kv-value">{identity.account}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value">{identity.arn}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">User ID</div><div className="svc-kv-value">{identity.userId}</div></div>
            </div>
          )}
        </div>

        {/* Decode Authorization Message */}
        <div className="svc-panel">
          <h3>Decode Authorization Message</h3>
          <div className="svc-form">
            <label><span>Encoded</span><textarea value={encodedMessage} onChange={e => setEncodedMessage(e.target.value)} placeholder="Encoded authorization message" /></label>
          </div>
          <div className="svc-btn-row">
            <button type="button" className="svc-btn primary" onClick={() => {
              void decodeAuthorizationMessage(connection, encodedMessage).then(r => { setDecodedMessage(r.decodedMessage); setMsg('Decoded successfully') }).catch(e => setError(String(e)))
            }}>Decode</button>
          </div>
          {decodedMessage && <pre className="svc-code" style={{ marginTop: 10, maxHeight: 140, overflow: 'auto' }}>{decodedMessage}</pre>}
        </div>

        {/* Access Key Ownership */}
        <div className="svc-panel">
          <h3>Access Key Ownership</h3>
          <div className="svc-inline" style={{ marginBottom: 10 }}>
            <input placeholder="AKIA..." value={accessKeyId} onChange={e => setAccessKeyId(e.target.value)} />
            <button type="button" className="svc-btn primary" onClick={() => {
              void lookupAccessKeyOwnership(connection, accessKeyId).then(setOwnership).catch(e => setError(String(e)))
            }}>Lookup</button>
          </div>
          {ownership && (
            <div className="svc-kv">
              <div className="svc-kv-row"><div className="svc-kv-label">User ID</div><div className="svc-kv-value">{ownership.userId}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">Account</div><div className="svc-kv-value">{ownership.account}</div></div>
              <div className="svc-kv-row"><div className="svc-kv-label">ARN</div><div className="svc-kv-value">{ownership.arn}</div></div>
            </div>
          )}
        </div>

        {/* Assume Role */}
        <div className="svc-panel">
          <h3>Assume Role</h3>
          <div className="svc-form">
            <label><span>Role ARN</span><input value={roleArn} onChange={e => setRoleArn(e.target.value)} /></label>
            <label><span>Session</span><input value={sessionName} onChange={e => setSessionName(e.target.value)} /></label>
            <label><span>External ID</span><input value={externalId} onChange={e => setExternalId(e.target.value)} placeholder="Optional" /></label>
          </div>
          <div className="svc-btn-row">
            <button type="button" className="svc-btn success" onClick={() => {
              void assumeRole(connection, roleArn, sessionName, externalId || undefined).then(r => { setAssumed(r); setMsg('Role assumed') }).catch(e => setError(String(e)))
            }}>Assume Role</button>
          </div>
          {assumed && <pre className="svc-code" style={{ marginTop: 10, maxHeight: 140, overflow: 'auto' }}>{JSON.stringify(assumed, null, 2)}</pre>}
        </div>
      </div>
    </div>
  )
}
