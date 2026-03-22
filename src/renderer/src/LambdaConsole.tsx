import { useEffect, useMemo, useState } from 'react'

import type { AwsConnection, LambdaCodeResult, LambdaCreateConfig, LambdaFunctionDetail, LambdaFunctionSummary } from '@shared/types'
import { createLambdaFunction, deleteLambdaFunction, getLambdaFunction, getLambdaFunctionCode, invokeLambdaFunction, listLambdaFunctions } from './api'
import { ConfirmButton } from './ConfirmButton'

type ColKey = 'functionName' | 'handler' | 'runtime' | 'memory' | 'lastModified'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'functionName', label: 'Function', color: '#3b82f6' },
  { key: 'handler', label: 'Handler', color: '#14b8a6' },
  { key: 'runtime', label: 'Runtime', color: '#8b5cf6' },
  { key: 'memory', label: 'Memory', color: '#f59e0b' },
  { key: 'lastModified', label: 'Modified', color: '#22c55e' },
]

const RUNTIMES = ['python3.12','python3.11','python3.10','nodejs22.x','nodejs20.x','nodejs18.x','java21','java17','dotnet8','dotnet6','ruby3.3','ruby3.2']

const STARTER: Record<string, string> = {
  python: `import json\n\ndef handler(event, context):\n    return {'statusCode': 200, 'body': json.dumps({'message': 'Hello!'})}\n`,
  node: `export const handler = async (event) => {\n  return { statusCode: 200, body: JSON.stringify({ message: 'Hello!' }) };\n};\n`,
  default: `# Lambda handler\n`
}

function starterFor(rt: string) { return rt.startsWith('python') ? STARTER.python : rt.startsWith('node') ? STARTER.node : STARTER.default }

function getVal(fn: LambdaFunctionSummary, k: ColKey) {
  switch (k) {
    case 'functionName': return fn.functionName
    case 'handler': return fn.handler
    case 'runtime': return fn.runtime
    case 'memory': return `${fn.memory} MB`
    case 'lastModified': return fn.lastModified
  }
}

type View = 'list' | 'code' | 'create'

export function LambdaConsole({ connection }: { connection: AwsConnection }) {
  const [functions, setFunctions] = useState<LambdaFunctionSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [detail, setDetail] = useState<LambdaFunctionDetail | null>(null)
  const [view, setView] = useState<View>('list')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map(c => c.key)))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')

  const [codeResult, setCodeResult] = useState<LambdaCodeResult | null>(null)
  const [codeFile, setCodeFile] = useState(0)
  const [payload, setPayload] = useState('{}')
  const [invokeResult, setInvokeResult] = useState('')
  const [invoking, setInvoking] = useState(false)
  const [showInvoke, setShowInvoke] = useState(false)

  const [createForm, setCreateForm] = useState<LambdaCreateConfig>({
    functionName: '', runtime: 'python3.12', handler: 'lambda_function.handler', role: '', code: STARTER.python, description: '', timeout: 30, memorySize: 128
  })

  async function load(selectName?: string) {
    setError(''); setLoading(true)
    try {
      const fns = await listLambdaFunctions(connection)
      setFunctions(fns)
      const resolved = selectName ?? selectedName ?? fns[0]?.functionName ?? ''
      if (resolved) { setSelectedName(resolved); setDetail(await getLambdaFunction(connection, resolved)) }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [connection.profile, connection.region])

  const activeCols = COLUMNS.filter(c => visCols.has(c.key))
  const filtered = useMemo(() => {
    if (!filter) return functions
    const q = filter.toLowerCase()
    return functions.filter(fn => activeCols.some(c => getVal(fn, c.key).toLowerCase().includes(q)))
  }, [functions, filter, activeCols])

  async function handleSelect(name: string) {
    setSelectedName(name); setError('')
    try { setDetail(await getLambdaFunction(connection, name)) } catch (e) { setError(String(e)) }
  }

  async function handleSeeCode() {
    if (!selectedName) return
    setError(''); setCodeFile(0)
    try { setCodeResult(await getLambdaFunctionCode(connection, selectedName)); setView('code') }
    catch (e) { setError(String(e)) }
  }

  async function handleInvoke() {
    if (!selectedName) return
    setInvoking(true); setInvokeResult('')
    try {
      const r = await invokeLambdaFunction(connection, selectedName, payload)
      setInvokeResult(r.functionError ? `ERROR: ${r.functionError}\n${r.rawPayload}` : r.rawPayload || JSON.stringify(r.payload, null, 2))
    } catch (e) { setInvokeResult(String(e)) }
    finally { setInvoking(false) }
  }

  async function handleCreate() {
    if (!createForm.functionName || !createForm.role) return
    setError('')
    try { await createLambdaFunction(connection, createForm); setMsg('Function created'); setView('list'); await load(createForm.functionName) }
    catch (e) { setError(String(e)) }
  }

  async function handleDelete() {
    if (!selectedName) return
    try { await deleteLambdaFunction(connection, selectedName); setMsg('Function deleted'); setSelectedName(''); setDetail(null); await load() }
    catch (e) { setError(String(e)) }
  }

  if (view === 'code') {
    return (
      <div className="svc-console">
        <div className="svc-tab-bar">
          <button className="svc-tab" type="button" onClick={() => setView('list')}>Back to Functions</button>
          <button className="svc-tab active" type="button">Code: {selectedName}</button>
        </div>
        {error && <div className="svc-error">{error}</div>}
        {codeResult && codeResult.files.length > 0 && (
          <>
            <div className="svc-chips">
              {codeResult.files.map((f, i) => (
                <button key={f.path} className={`svc-chip ${i === codeFile ? 'active' : ''}`} type="button" style={i === codeFile ? { background: '#3b82f6', borderColor: '#3b82f6' } : undefined} onClick={() => setCodeFile(i)}>{f.path}</button>
              ))}
            </div>
            <pre className="svc-code" style={{ maxHeight: 'calc(100vh - 300px)', overflow: 'auto' }}>{codeResult.files[codeFile].content}</pre>
          </>
        )}
        {codeResult && codeResult.files.length === 0 && <div className="svc-empty">No readable source files found.</div>}
      </div>
    )
  }

  if (view === 'create') {
    return (
      <div className="svc-console">
        <div className="svc-tab-bar">
          <button className="svc-tab" type="button" onClick={() => setView('list')}>Cancel</button>
          <button className="svc-tab active" type="button">Create Function</button>
        </div>
        {error && <div className="svc-error">{error}</div>}
        <div className="svc-panel">
          <div className="svc-form">
            <label><span>Name</span><input value={createForm.functionName} onChange={e => setCreateForm(f => ({ ...f, functionName: e.target.value }))} placeholder="my-function" /></label>
            <label><span>Runtime</span><select value={createForm.runtime} onChange={e => {
              const rt = e.target.value; const hf = rt.startsWith('python') ? 'lambda_function' : rt.startsWith('node') ? 'index' : 'Handler'
              setCreateForm(f => ({ ...f, runtime: rt, handler: rt.startsWith('java') ? 'example.Handler::handleRequest' : `${hf}.handler`, code: starterFor(rt) }))
            }}>{RUNTIMES.map(r => <option key={r} value={r}>{r}</option>)}</select></label>
            <label><span>Handler</span><input value={createForm.handler} onChange={e => setCreateForm(f => ({ ...f, handler: e.target.value }))} /></label>
            <label><span>Role ARN</span><input value={createForm.role} onChange={e => setCreateForm(f => ({ ...f, role: e.target.value }))} placeholder="arn:aws:iam::..." /></label>
            <label><span>Description</span><input value={createForm.description ?? ''} onChange={e => setCreateForm(f => ({ ...f, description: e.target.value }))} /></label>
            <label><span>Timeout (s)</span><input type="number" value={createForm.timeout ?? 30} onChange={e => setCreateForm(f => ({ ...f, timeout: parseInt(e.target.value) || 30 }))} /></label>
            <label><span>Memory (MB)</span><input type="number" value={createForm.memorySize ?? 128} onChange={e => setCreateForm(f => ({ ...f, memorySize: parseInt(e.target.value) || 128 }))} /></label>
          </div>
          <label style={{ display: 'block', fontSize: 12, color: '#9ca7b7', marginBottom: 6 }}>Function Code</label>
          <textarea value={createForm.code} onChange={e => setCreateForm(f => ({ ...f, code: e.target.value }))} rows={14} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12, background: '#0f1318', border: '1px solid #3b4350', borderRadius: 4, color: '#edf1f6', padding: 10, resize: 'vertical' }} />
          <div className="svc-btn-row" style={{ marginTop: 12 }}>
            <button type="button" className="svc-btn success" disabled={!createForm.functionName || !createForm.role} onClick={() => void handleCreate()}>Create Function</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className="svc-tab active" type="button">Functions</button>
        <button className="svc-tab right" type="button" onClick={() => void load()}>Refresh</button>
      </div>

      {msg && <div className="svc-msg">{msg}</div>}
      {error && <div className="svc-error">{error}</div>}

      <input className="svc-search" placeholder="Filter rows across selected columns..." value={filter} onChange={e => setFilter(e.target.value)} />

      <div className="svc-chips">
        {COLUMNS.map(col => (
          <button
            key={col.key}
            className={`svc-chip ${visCols.has(col.key) ? 'active' : ''}`}
            type="button"
            style={visCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
            onClick={() => setVisCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
          >{col.label}</button>
        ))}
      </div>

      <div className="svc-layout">
        <div className="svc-table-area">
          <table className="svc-table">
            <thead><tr>{activeCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
            <tbody>
              {loading && <tr><td colSpan={activeCols.length}>Gathering data</td></tr>}
              {!loading && filtered.map(fn => (
                <tr key={fn.functionName} className={fn.functionName === selectedName ? 'active' : ''} onClick={() => void handleSelect(fn.functionName)}>
                  {activeCols.map(c => <td key={c.key}>{getVal(fn, c.key)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {loading && filtered.length === 0 && <div className="svc-empty">Gathering data</div>}
          {!loading && !filtered.length && <div className="svc-empty">No functions found.</div>}
        </div>

        <div className="svc-sidebar">
          <div className="svc-section">
            <h3>Actions</h3>
            <div className="svc-actions">
              <button className="svc-btn success" type="button" onClick={() => setView('create')}>New Function</button>
              <button className="svc-btn primary" type="button" disabled={!selectedName} onClick={() => void handleSeeCode()}>See Code</button>
              <button className="svc-btn teal" type="button" disabled={!selectedName} onClick={() => setShowInvoke(!showInvoke)}>{showInvoke ? 'Hide Invoke' : 'Run Function'}</button>
              <ConfirmButton className="svc-btn danger" onConfirm={() => void handleDelete()}>Delete</ConfirmButton>
            </div>
          </div>

          {detail && (
            <div className="svc-section">
              <h3>Details</h3>
              <div className="svc-kv">
                <div className="svc-kv-row"><div className="svc-kv-label">Name</div><div className="svc-kv-value">{detail.functionName}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Runtime</div><div className="svc-kv-value">{detail.runtime}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Handler</div><div className="svc-kv-value">{detail.handler}</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Memory</div><div className="svc-kv-value">{detail.memorySize} MB</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Timeout</div><div className="svc-kv-value">{detail.timeout}s</div></div>
                <div className="svc-kv-row"><div className="svc-kv-label">Role</div><div className="svc-kv-value">{detail.role}</div></div>
              </div>
            </div>
          )}

          {showInvoke && selectedName && (
            <div className="svc-section">
              <h3>Invoke: {selectedName}</h3>
              <div className="svc-form">
                <label><span>Payload</span><textarea value={payload} onChange={e => setPayload(e.target.value)} rows={5} /></label>
              </div>
              <button type="button" className="svc-btn success" disabled={invoking} onClick={() => void handleInvoke()}>{invoking ? 'Invoking...' : 'Invoke'}</button>
              {invokeResult && <pre className="svc-code" style={{ marginTop: 10, maxHeight: 200, overflow: 'auto' }}>{invokeResult}</pre>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
