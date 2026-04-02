import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { AwsConnection, LambdaCodeResult, LambdaCreateConfig, LambdaFunctionDetail, LambdaFunctionSummary, ServiceId } from '@shared/types'
import { createLambdaFunction, deleteLambdaFunction, getLambdaFunction, getLambdaFunctionCode, invokeLambdaFunction, listLambdaFunctions } from './api'
import { ConfirmButton } from './ConfirmButton'
import { SvcState } from './SvcState'
import './lambda.css'

type ColKey = 'functionName' | 'handler' | 'runtime' | 'memory' | 'lastModified'
type DetailTab = 'overview' | 'invoke' | 'code'

const COLUMNS: { key: ColKey; label: string; color: string }[] = [
  { key: 'functionName', label: 'Function', color: '#4a8fe7' },
  { key: 'handler', label: 'Handler', color: '#35b7a6' },
  { key: 'runtime', label: 'Runtime', color: '#8a7cf4' },
  { key: 'memory', label: 'Memory', color: '#f59a3d' },
  { key: 'lastModified', label: 'Modified', color: '#61c987' }
]

const RUNTIMES = ['python3.12', 'python3.11', 'python3.10', 'nodejs22.x', 'nodejs20.x', 'nodejs18.x', 'java21', 'java17', 'dotnet8', 'dotnet6', 'ruby3.3', 'ruby3.2']

const STARTER: Record<string, string> = {
  python: `import json\n\ndef handler(event, context):\n    return {'statusCode': 200, 'body': json.dumps({'message': 'Hello!'})}\n`,
  node: `export const handler = async (event) => {\n  return { statusCode: 200, body: JSON.stringify({ message: 'Hello!' }) };\n};\n`,
  default: `# Lambda handler\n`
}

const starterFor = (runtime: string) => runtime.startsWith('python') ? STARTER.python : runtime.startsWith('node') ? STARTER.node : STARTER.default
const runtimeFamily = (runtime: string) => runtime.startsWith('python') ? 'Python' : runtime.startsWith('node') ? 'Node.js' : runtime.startsWith('java') ? 'Java' : runtime.startsWith('dotnet') ? '.NET' : runtime.startsWith('ruby') ? 'Ruby' : runtime || 'Unknown'
const updateHandlerForRuntime = (runtime: string) => runtime.startsWith('java') ? 'example.Handler::handleRequest' : `${runtime.startsWith('python') ? 'lambda_function' : runtime.startsWith('node') ? 'index' : 'Handler'}.handler`
const formatMemory = (value: number | string | undefined) => typeof value === 'number' ? `${value} MB` : typeof value === 'string' && value.trim() ? (value.toLowerCase().includes('mb') ? value : `${value} MB`) : '-'
const parseMemory = (value: number | string | undefined) => typeof value === 'number' ? value : Number(value?.toString().match(/\d+/)?.[0] ?? 0)
const getVal = (fn: LambdaFunctionSummary, key: ColKey) => key === 'functionName' ? fn.functionName : key === 'handler' ? fn.handler : key === 'runtime' ? fn.runtime : key === 'memory' ? formatMemory(fn.memory) : fn.lastModified
const shellLabel = (connection: AwsConnection) => connection.kind === 'profile' ? connection.profile : connection.accountId
const shellSubtitle = (connection: AwsConnection) => connection.kind === 'profile' ? connection.label : `${connection.sourceProfile} -> ${connection.roleArn.split('/').pop() ?? connection.roleArn}`
const toneForState = (state: string) => state.toLowerCase() === 'active' ? 'success' : state.toLowerCase() === 'pending' ? 'warning' : ['failed', 'inactive'].includes(state.toLowerCase()) ? 'danger' : 'info'

function formatDate(value: string) {
  if (!value) return '-'
  try {
    return new Date(value).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return value
  }
}

export function LambdaConsole({
  connection,
  focusFunctionName,
  onNavigateCloudWatch
}: {
  connection: AwsConnection
  focusFunctionName?: { token: number; functionName: string } | null
  onNavigateCloudWatch?: (focus: { logGroupNames?: string[]; queryString?: string; sourceLabel?: string; serviceHint?: ServiceId | '' }) => void
}) {
  const [functions, setFunctions] = useState<LambdaFunctionSummary[]>([])
  const [selectedName, setSelectedName] = useState('')
  const [detail, setDetail] = useState<LambdaFunctionDetail | null>(null)
  const [view, setView] = useState<'list' | 'create'>('list')
  const [detailTab, setDetailTab] = useState<DetailTab>('overview')
  const [filter, setFilter] = useState('')
  const [visCols, setVisCols] = useState<Set<ColKey>>(() => new Set(COLUMNS.map((column) => column.key)))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [msg, setMsg] = useState('')
  const [codeResult, setCodeResult] = useState<LambdaCodeResult | null>(null)
  const [codeFile, setCodeFile] = useState(0)
  const [codeLoading, setCodeLoading] = useState(false)
  const [payload, setPayload] = useState('{}')
  const [invokeResult, setInvokeResult] = useState('')
  const [invoking, setInvoking] = useState(false)
  const [appliedFocusToken, setAppliedFocusToken] = useState(0)
  const [createForm, setCreateForm] = useState<LambdaCreateConfig>({
    functionName: '',
    runtime: 'python3.12',
    handler: 'lambda_function.handler',
    role: '',
    code: STARTER.python,
    description: '',
    timeout: 30,
    memorySize: 128
  })

  const activeCols = useMemo(() => COLUMNS.filter((column) => visCols.has(column.key)), [visCols])
  const filtered = useMemo(() => {
    if (!filter) return functions
    const query = filter.toLowerCase()
    return functions.filter((fn) => activeCols.some((column) => getVal(fn, column.key).toLowerCase().includes(query)))
  }, [activeCols, filter, functions])
  const selectedSummary = useMemo(() => functions.find((fn) => fn.functionName === selectedName) ?? null, [functions, selectedName])
  const runtimeFamilies = useMemo(() => new Set(functions.map((fn) => runtimeFamily(fn.runtime))).size, [functions])
  const totalMemory = useMemo(() => functions.reduce((sum, fn) => sum + parseMemory(fn.memory), 0), [functions])
  const selectedEnvCount = detail ? Object.keys(detail.environment).length : 0
  const selectedTagEntries = selectedSummary?.tags ? Object.entries(selectedSummary.tags) : []

  async function load(selectName?: string) {
    setError('')
    setLoading(true)
    try {
      const nextFunctions = await listLambdaFunctions(connection)
      setFunctions(nextFunctions)
      const resolved = selectName ?? selectedName ?? nextFunctions[0]?.functionName ?? ''
      if (!resolved) {
        setSelectedName('')
        setDetail(null)
        return
      }
      setSelectedName(resolved)
      setDetail(await getLambdaFunction(connection, resolved))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function handleSelect(name: string) {
    setSelectedName(name)
    setError('')
    setMsg('')
    setDetailTab('overview')
    setCodeResult(null)
    setCodeFile(0)
    setInvokeResult('')
    try {
      setDetail(await getLambdaFunction(connection, name))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  async function ensureCodeLoaded(force = false) {
    if (!selectedName || (codeResult && !force)) return
    setCodeLoading(true)
    setError('')
    try {
      const nextCode = await getLambdaFunctionCode(connection, selectedName)
      setCodeResult(nextCode)
      setCodeFile(0)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCodeLoading(false)
    }
  }

  async function handleInvoke() {
    if (!selectedName) return
    setInvoking(true)
    setInvokeResult('')
    try {
      const result = await invokeLambdaFunction(connection, selectedName, payload)
      setInvokeResult(result.functionError ? `ERROR: ${result.functionError}\n${result.rawPayload}` : result.rawPayload || JSON.stringify(result.payload, null, 2))
    } catch (err) {
      setInvokeResult(String(err))
    } finally {
      setInvoking(false)
    }
  }

  async function handleCreate() {
    if (!createForm.functionName || !createForm.role) return
    setError('')
    try {
      await createLambdaFunction(connection, createForm)
      setMsg('Function created')
      setView('list')
      setDetailTab('overview')
      await load(createForm.functionName)
    } catch (err) {
      setError(String(err))
    }
  }

  async function handleDelete() {
    if (!selectedName) return
    try {
      await deleteLambdaFunction(connection, selectedName)
      setMsg('Function deleted')
      setSelectedName('')
      setDetail(null)
      setCodeResult(null)
      setInvokeResult('')
      await load()
    } catch (err) {
      setError(String(err))
    }
  }

  useEffect(() => { void load() }, [connection.sessionId, connection.region])

  useEffect(() => {
    if (!focusFunctionName || focusFunctionName.token === appliedFocusToken) return
    const match = functions.find((fn) => fn.functionName === focusFunctionName.functionName)
    if (!match) return
    setAppliedFocusToken(focusFunctionName.token)
    setView('list')
    void handleSelect(match.functionName)
  }, [appliedFocusToken, focusFunctionName, functions])

  const createView = (
    <div className="lambda-console">
      <section className="lambda-shell-hero">
        <div className="lambda-shell-hero-copy">
          <div className="eyebrow">Function authoring</div>
          <h2>Create Lambda Function</h2>
          <p>Provision a new function in the current active context with the same operator-first visual system used by Terraform.</p>
          <div className="lambda-shell-meta-strip">
            <div className="lambda-shell-meta-pill"><span>Connection</span><strong>{shellLabel(connection)}</strong></div>
            <div className="lambda-shell-meta-pill"><span>Region</span><strong>{connection.region}</strong></div>
            <div className="lambda-shell-meta-pill"><span>Runtime family</span><strong>{runtimeFamily(createForm.runtime)}</strong></div>
          </div>
        </div>
        <div className="lambda-shell-hero-stats">
          <div className="lambda-shell-stat-card lambda-shell-stat-card-accent"><span>Handler</span><strong>{createForm.handler || '-'}</strong><small>Entry point for the deployment package.</small></div>
          <div className="lambda-shell-stat-card"><span>Timeout</span><strong>{createForm.timeout ?? 30}s</strong><small>Execution ceiling per invoke.</small></div>
          <div className="lambda-shell-stat-card"><span>Memory</span><strong>{createForm.memorySize ?? 128} MB</strong><small>Initial compute allocation.</small></div>
          <div className="lambda-shell-stat-card"><span>Code</span><strong>{createForm.code.split('\n').length} lines</strong><small>Inline source bundled into the zip.</small></div>
        </div>
      </section>
      {error && <div className="lambda-msg error">{error}</div>}
      <div className="lambda-create-layout">
        <section className="lambda-section">
          <div className="lambda-section-head"><div><span className="lambda-pane-kicker">Configuration</span><h3>Runtime and deployment inputs</h3></div></div>
          <div className="lambda-form-grid">
            <label className="lambda-field"><span>Name</span><input value={createForm.functionName} onChange={(event) => setCreateForm((current) => ({ ...current, functionName: event.target.value }))} placeholder="my-function" /></label>
            <label className="lambda-field"><span>Runtime</span><select value={createForm.runtime} onChange={(event) => { const runtime = event.target.value; setCreateForm((current) => ({ ...current, runtime, handler: updateHandlerForRuntime(runtime), code: starterFor(runtime) })) }}>{RUNTIMES.map((runtime) => <option key={runtime} value={runtime}>{runtime}</option>)}</select></label>
            <label className="lambda-field"><span>Handler</span><input value={createForm.handler} onChange={(event) => setCreateForm((current) => ({ ...current, handler: event.target.value }))} /></label>
            <label className="lambda-field"><span>Role ARN</span><input value={createForm.role} onChange={(event) => setCreateForm((current) => ({ ...current, role: event.target.value }))} placeholder="arn:aws:iam::..." /></label>
            <label className="lambda-field"><span>Description</span><input value={createForm.description ?? ''} onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))} /></label>
            <label className="lambda-field"><span>Timeout (s)</span><input type="number" value={createForm.timeout ?? 30} onChange={(event) => setCreateForm((current) => ({ ...current, timeout: parseInt(event.target.value, 10) || 30 }))} /></label>
            <label className="lambda-field"><span>Memory (MB)</span><input type="number" value={createForm.memorySize ?? 128} onChange={(event) => setCreateForm((current) => ({ ...current, memorySize: parseInt(event.target.value, 10) || 128 }))} /></label>
          </div>
          <div className="lambda-btn-row">
            <button type="button" className="lambda-toolbar-btn" onClick={() => setView('list')}>Cancel</button>
            <button type="button" className="lambda-toolbar-btn accent" disabled={!createForm.functionName || !createForm.role} onClick={() => void handleCreate()}>Create Function</button>
          </div>
        </section>
        <section className="lambda-section lambda-editor-section">
          <div className="lambda-section-head"><div><span className="lambda-pane-kicker">Source</span><h3>Inline function code</h3></div><span className="lambda-pane-summary">{runtimeFamily(createForm.runtime)}</span></div>
          <textarea className="lambda-code-editor" value={createForm.code} onChange={(event) => setCreateForm((current) => ({ ...current, code: event.target.value }))} rows={18} />
        </section>
      </div>
    </div>
  )

  const listView = (
    <div className="lambda-console">
      <section className="lambda-shell-hero">
        <div className="lambda-shell-hero-copy">
          <div className="eyebrow">Lambda operations</div>
          <h2>Serverless Function Control Plane</h2>
          <p>Inspect runtime posture, view deployed code, run payloads, and manage Lambda inventory without changing underlying service behavior.</p>
          <div className="lambda-shell-meta-strip">
            <div className="lambda-shell-meta-pill"><span>Connection</span><strong>{shellLabel(connection)}</strong></div>
            <div className="lambda-shell-meta-pill"><span>Scope</span><strong>{shellSubtitle(connection)}</strong></div>
            <div className="lambda-shell-meta-pill"><span>Region</span><strong>{connection.region}</strong></div>
          </div>
        </div>
        <div className="lambda-shell-hero-stats">
          <div className="lambda-shell-stat-card lambda-shell-stat-card-accent"><span>Functions</span><strong>{functions.length}</strong><small>Total inventory in the selected region.</small></div>
          <div className="lambda-shell-stat-card"><span>Filtered</span><strong>{filtered.length}</strong><small>Search results across enabled fields.</small></div>
          <div className="lambda-shell-stat-card"><span>Runtime families</span><strong>{runtimeFamilies}</strong><small>Distinct execution stacks deployed.</small></div>
          <div className="lambda-shell-stat-card"><span>Memory footprint</span><strong>{totalMemory} MB</strong><small>Aggregate configured memory.</small></div>
        </div>
      </section>
      <div className="lambda-shell-toolbar">
        <div className="lambda-toolbar-search">
          <label className="lambda-search-field">
            <span>Search inventory</span>
            <input className="lambda-search-input" placeholder="Filter across enabled search fields..." value={filter} onChange={(event) => setFilter(event.target.value)} />
          </label>
          <div className="lambda-chip-row">
            {COLUMNS.map((column) => (
              <button key={column.key} type="button" className={`lambda-chip ${visCols.has(column.key) ? 'active' : ''}`} style={visCols.has(column.key) ? { '--lambda-chip-color': column.color } as CSSProperties : undefined} onClick={() => setVisCols((current) => { const next = new Set(current); next.has(column.key) ? next.delete(column.key) : next.add(column.key); return next })}>{column.label}</button>
            ))}
          </div>
        </div>
        <div className="lambda-toolbar-actions">
          <button type="button" className="lambda-toolbar-btn" onClick={() => void load(selectedName || undefined)}>Refresh</button>
          <button type="button" className="lambda-toolbar-btn accent" onClick={() => setView('create')}>New Function</button>
        </div>
      </div>
      {msg && <div className="lambda-msg">{msg}</div>}
      {error && <div className="lambda-msg error">{error}</div>}
      <div className="lambda-main-layout">
        <div className="lambda-function-rail">
          <div className="lambda-pane-head"><div><span className="lambda-pane-kicker">Tracked functions</span><h3>Inventory</h3></div><span className="lambda-pane-summary">{filtered.length} shown</span></div>
          {loading && filtered.length === 0 ? <SvcState variant="loading" resourceName="functions" message="Gathering Lambda inventory..." /> : filtered.length === 0 ? <SvcState variant={filter ? 'no-filter-matches' : 'empty'} resourceName="functions" message={filter ? 'No functions match the current search scope.' : 'No functions found in this region.'} /> : (
            <div className="lambda-function-list">
              {filtered.map((fn) => (
                <button key={fn.functionName} type="button" className={`lambda-function-row ${fn.functionName === selectedName ? 'active' : ''}`} onClick={() => void handleSelect(fn.functionName)}>
                  <div className="lambda-function-row-head">
                    <div className="lambda-function-row-copy"><strong>{fn.functionName}</strong><span>{fn.handler}</span></div>
                    <span className="lambda-runtime-badge">{runtimeFamily(fn.runtime)}</span>
                  </div>
                  <div className="lambda-function-row-meta"><span>{fn.runtime}</span><span>{formatMemory(fn.memory)}</span><span>{formatDate(fn.lastModified)}</span></div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="lambda-detail-pane">
          {!detail ? <SvcState variant="no-selection" resourceName="function" message="Select a Lambda function to inspect runtime details and operator actions." /> : (
            <>
              <section className="lambda-detail-hero">
                <div className="lambda-detail-hero-copy">
                  <div className="eyebrow">Runtime posture</div>
                  <h3>{detail.functionName}</h3>
                  <p>{detail.description || detail.functionArn}</p>
                  <div className="lambda-detail-meta-strip">
                    <div className="lambda-detail-meta-pill"><span>State</span><strong>{detail.state}</strong></div>
                    <div className="lambda-detail-meta-pill"><span>Update status</span><strong>{detail.lastUpdateStatus}</strong></div>
                    <div className="lambda-detail-meta-pill"><span>Runtime</span><strong>{detail.runtime}</strong></div>
                    <div className="lambda-detail-meta-pill"><span>Handler</span><strong>{detail.handler}</strong></div>
                  </div>
                </div>
                <div className="lambda-detail-hero-stats">
                  <div className={`lambda-detail-stat-card ${toneForState(detail.state)}`}><span>Lifecycle</span><strong>{detail.state}</strong><small>{detail.lastUpdateStatus}</small></div>
                  <div className="lambda-detail-stat-card"><span>Memory</span><strong>{detail.memorySize} MB</strong><small>Configured execution memory.</small></div>
                  <div className="lambda-detail-stat-card"><span>Timeout</span><strong>{detail.timeout}s</strong><small>Upper bound for each invocation.</small></div>
                  <div className="lambda-detail-stat-card"><span>Context</span><strong>{selectedEnvCount + selectedTagEntries.length}</strong><small>{selectedEnvCount} env vars and {selectedTagEntries.length} tags.</small></div>
                </div>
              </section>
              <div className="lambda-detail-tabs">
                <button type="button" className={detailTab === 'overview' ? 'active' : ''} onClick={() => setDetailTab('overview')}>Overview</button>
                <button type="button" className={detailTab === 'invoke' ? 'active' : ''} onClick={() => setDetailTab('invoke')}>Invoke</button>
                <button type="button" className={detailTab === 'code' ? 'active' : ''} onClick={() => { setDetailTab('code'); void ensureCodeLoaded() }}>Code</button>
              </div>
              {detailTab === 'overview' && (
                <>
                  <section className="lambda-section">
                    <div className="lambda-section-head"><div><span className="lambda-pane-kicker">Actions</span><h3>Operator workflow</h3></div></div>
                    <div className="lambda-action-grid">
                      <button type="button" className="lambda-toolbar-btn accent" onClick={() => setView('create')}>Create Function</button>
                      <button type="button" className="lambda-toolbar-btn" onClick={() => { setDetailTab('code'); void ensureCodeLoaded() }}>Open Source</button>
                      <button type="button" className="lambda-toolbar-btn" onClick={() => setDetailTab('invoke')}>Invoke Function</button>
                      <button
                        type="button"
                        className="lambda-toolbar-btn"
                        disabled={!onNavigateCloudWatch}
                        onClick={() => onNavigateCloudWatch?.({
                          logGroupNames: [`/aws/lambda/${detail.functionName}`],
                          queryString: [
                            'fields @timestamp, @requestId, @message',
                            `| filter @message like /(?i)(${detail.functionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|error|exception|timeout)/`,
                            '| sort @timestamp desc',
                            '| limit 50'
                          ].join('\n'),
                          sourceLabel: detail.functionName,
                          serviceHint: 'lambda'
                        })}
                      >
                        Investigate Logs
                      </button>
                      <ConfirmButton
                        className="lambda-toolbar-btn danger"
                        onConfirm={() => void handleDelete()}
                        modalTitle="Delete Lambda function"
                        modalBody="Deleting the function removes the deployed code and breaks any callers that still invoke it."
                        summaryItems={[
                          `Function: ${detail.functionName}`,
                          `Runtime: ${detail.runtime}`,
                          `Region: ${connection.region}`
                        ]}
                        confirmPhrase={detail.functionName}
                        confirmButtonLabel="Delete function"
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                  </section>
                  <section className="lambda-section">
                    <div className="lambda-section-head"><div><span className="lambda-pane-kicker">Configuration</span><h3>Deployment details</h3></div></div>
                    <div className="lambda-kv">
                      <div className="lambda-kv-row"><div className="lambda-kv-label">Name</div><div className="lambda-kv-value">{detail.functionName}</div></div>
                      <div className="lambda-kv-row"><div className="lambda-kv-label">ARN</div><div className="lambda-kv-value">{detail.functionArn}</div></div>
                      <div className="lambda-kv-row"><div className="lambda-kv-label">Runtime</div><div className="lambda-kv-value">{detail.runtime}</div></div>
                      <div className="lambda-kv-row"><div className="lambda-kv-label">Handler</div><div className="lambda-kv-value">{detail.handler}</div></div>
                      <div className="lambda-kv-row"><div className="lambda-kv-label">Role</div><div className="lambda-kv-value">{detail.role}</div></div>
                      <div className="lambda-kv-row"><div className="lambda-kv-label">Memory</div><div className="lambda-kv-value">{detail.memorySize} MB</div></div>
                      <div className="lambda-kv-row"><div className="lambda-kv-label">Timeout</div><div className="lambda-kv-value">{detail.timeout}s</div></div>
                      <div className="lambda-kv-row"><div className="lambda-kv-label">Last modified</div><div className="lambda-kv-value">{formatDate(detail.lastModified)}</div></div>
                    </div>
                  </section>
                  <div className="lambda-info-grid">
                    <section className="lambda-section">
                      <div className="lambda-section-head"><div><span className="lambda-pane-kicker">Environment</span><h3>Injected variables</h3></div><span className="lambda-pane-summary">{selectedEnvCount}</span></div>
                      {selectedEnvCount === 0 ? <SvcState variant="empty" resourceName="environment variables" message="No environment variables configured." compact /> : <div className="lambda-list-block">{Object.entries(detail.environment).map(([key, value]) => <div key={key} className="lambda-list-row"><strong>{key}</strong><span>{value}</span></div>)}</div>}
                    </section>
                    <section className="lambda-section">
                      <div className="lambda-section-head"><div><span className="lambda-pane-kicker">Metadata</span><h3>Function tags</h3></div><span className="lambda-pane-summary">{selectedTagEntries.length}</span></div>
                      {selectedTagEntries.length === 0 ? <SvcState variant="empty" resourceName="tags" message="No tags available on this function." compact /> : <div className="lambda-tag-grid">{selectedTagEntries.map(([key, value]) => <div key={key} className="lambda-tag-card"><span>{key}</span><strong>{value}</strong></div>)}</div>}
                    </section>
                  </div>
                </>
              )}
              {detailTab === 'invoke' && (
                <section className="lambda-section">
                  <div className="lambda-section-head"><div><span className="lambda-pane-kicker">Invocation</span><h3>Run test payload</h3></div><span className="lambda-pane-summary">{detail.functionName}</span></div>
                  <label className="lambda-field"><span>Payload</span><textarea value={payload} onChange={(event) => setPayload(event.target.value)} rows={8} /></label>
                  <div className="lambda-btn-row"><button type="button" className="lambda-toolbar-btn accent" disabled={invoking} onClick={() => void handleInvoke()}>{invoking ? 'Invoking...' : 'Invoke'}</button></div>
                  {invokeResult && <pre className="lambda-code-viewer">{invokeResult}</pre>}
                </section>
              )}
              {detailTab === 'code' && (
                <section className="lambda-section">
                  <div className="lambda-section-head"><div><span className="lambda-pane-kicker">Source</span><h3>Deployed bundle contents</h3></div><div className="lambda-inline-head-actions">{codeResult?.truncated && <span className="lambda-inline-note">Archive was truncated to readable files.</span>}<button type="button" className="lambda-toolbar-btn" disabled={codeLoading} onClick={() => void ensureCodeLoaded(Boolean(codeResult))}>{codeLoading ? 'Loading...' : codeResult ? 'Reload Code' : 'Load Code'}</button></div></div>
                  {codeLoading ? <SvcState variant="loading" resourceName="function code" message="Reading deployed archive..." compact /> : !codeResult ? <SvcState variant="empty" resourceName="function code" message="Load code to inspect the deployed files." compact /> : codeResult.files.length === 0 ? <SvcState variant="empty" resourceName="source files" message="No readable source files found." compact /> : <>
                    <div className="lambda-chip-row">{codeResult.files.map((file, index) => <button key={file.path} type="button" className={`lambda-chip ${index === codeFile ? 'active' : ''}`} onClick={() => setCodeFile(index)}>{file.path}</button>)}</div>
                    <pre className="lambda-code-viewer">{codeResult.files[codeFile].content}</pre>
                  </>}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )

  return view === 'create' ? createView : listView
}
