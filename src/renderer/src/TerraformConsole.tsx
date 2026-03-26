import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './terraform.css'

import type {
  AwsConnection,
  TerraformActionRow,
  TerraformCliInfo,
  TerraformCommandLog,
  TerraformDriftItem,
  TerraformDriftReport,
  TerraformDriftStatus,
  TerraformDiagram,
  TerraformGraphEdge,
  TerraformGraphNode,
  TerraformPlanChange,
  TerraformProject,
  TerraformProjectListItem,
  TerraformResourceRow
} from '@shared/types'
import { openExternalUrl } from './api'
import {
  addProject,
  chooseProjectDirectory,
  chooseVarFile,
  clearSavedPlan,
  detectCli,
  detectMissingVars,
  getDrift,
  getProject,
  listProjects,
  reloadProject,
  removeProject,
  runCommand,
  setSelectedProjectId,
  subscribe,
  unsubscribe,
  updateInputs
} from './terraformApi'

type DetailTab = 'actions' | 'resources' | 'drift'

/* ── db_password validation ───────────────────────────────── */

function validateDbPassword(val: unknown): string | null {
  if (typeof val !== 'string') return 'db_password must be a string'
  if (!val) return 'db_password must not be empty'
  if (/\s/.test(val)) return 'db_password must not contain spaces'
  if (/[/@"]/.test(val)) return 'db_password must not contain /, @, or "'
  if (!/^[\x20-\x7e]+$/.test(val)) return 'db_password must contain only printable ASCII'
  return null
}

function validateVariablesJson(text: string): { parsed: Record<string, unknown> | null; error: string } {
  if (!text.trim()) return { parsed: {}, error: '' }
  try {
    const obj = JSON.parse(text)
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { parsed: null, error: 'Root must be a JSON object' }
    if ('db_password' in obj) {
      const pwErr = validateDbPassword(obj.db_password)
      if (pwErr) return { parsed: null, error: pwErr }
    }
    return { parsed: obj as Record<string, unknown>, error: '' }
  } catch (err) {
    return { parsed: null, error: err instanceof Error ? err.message : 'Invalid JSON' }
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function parsePlanSummaryFromOutput(output: string): TerraformProject['lastPlanSummary'] | null {
  const match = output.match(/Plan:\s*(\d+)\s+to add,\s*(\d+)\s+to change,\s*(\d+)\s+to destroy\./i)
  if (!match) return null
  return {
    create: Number(match[1] ?? 0),
    update: Number(match[2] ?? 0),
    delete: Number(match[3] ?? 0),
    replace: 0,
    noop: 0
  }
}

/* ── Inputs Dialog ────────────────────────────────────────── */

function InputsDialog({
  project,
  onSave,
  onClose,
  prefillMissing
}: {
  project: TerraformProject
  onSave: (variables: Record<string, unknown>, varFile: string) => void
  onClose: () => void
  prefillMissing?: string[]
}) {
  const [varFile, setVarFile] = useState(project.varFile ?? '')
  const [jsonText, setJsonText] = useState(() => {
    const vars = { ...(project.variables ?? {}) }
    if (prefillMissing) {
      for (const name of prefillMissing) {
        if (!(name in vars)) vars[name] = ''
      }
    }
    return Object.keys(vars).length > 0 ? JSON.stringify(vars, null, 2) : ''
  })
  const [validationError, setValidationError] = useState('')

  async function handleBrowse() {
    const chosen = await chooseVarFile()
    if (chosen) setVarFile(chosen)
  }

  function handleSave() {
    const { parsed, error } = validateVariablesJson(jsonText)
    if (error) { setValidationError(error); return }
    setValidationError('')
    onSave(parsed ?? {}, varFile)
  }

  return (
    <div className="tf-inputs-overlay" onClick={onClose}>
      <div className="tf-inputs-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Inputs for {project.name}</h3>
        <p style={{ margin: 0, fontSize: 12, color: '#9ca7b7' }}>
          You can provide a .tfvars file, JSON variables, or both. Variables are exported as TF_VAR_* and written to an auto.tfvars.json file.
        </p>
        {prefillMissing && prefillMissing.length > 0 && (
          <p style={{ margin: 0, fontSize: 12, color: '#f39c12' }}>
            Required now: {uniqueStrings(prefillMissing).join(', ')}
          </p>
        )}
        <label>
          Var File Path
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={varFile} onChange={(e) => setVarFile(e.target.value)} placeholder="path/to/terraform.tfvars" style={{ flex: 1 }} />
            <button type="button" className="tf-toolbar-btn" onClick={handleBrowse}>Browse</button>
          </div>
        </label>
        <label>
          Variables (JSON)
          <textarea value={jsonText} onChange={(e) => { setJsonText(e.target.value); setValidationError('') }} placeholder='{"key": "value"}' />
        </label>
        {validationError && <div className="tf-inputs-error">{validationError}</div>}
        {project.detectedVariables.length > 0 && (
          <div style={{ fontSize: 11, color: '#6b7688' }}>
            Detected variables: {project.detectedVariables.map((v) => v.name).join(', ')}
          </div>
        )}
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="tf-toolbar-btn accent" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}

/* ── Typed Confirmation Dialog ────────────────────────────── */

function TypedConfirmDialog({
  title,
  description,
  confirmWord,
  onConfirm,
  onCancel
}: {
  title: string
  description: string
  confirmWord: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')
  return (
    <div className="tf-confirm-overlay" onClick={onCancel}>
      <div className="tf-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{description}</p>
        <p style={{ fontSize: 12, color: '#e05252' }}>Type <strong>{confirmWord}</strong> to confirm:</p>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="tf-toolbar-btn danger" disabled={typed !== confirmWord} onClick={onConfirm}>{confirmWord}</button>
        </div>
      </div>
    </div>
  )
}

/* ── Summary Confirmation Dialog ──────────────────────────── */

const ACTION_COLORS: Record<string, string> = {
  create: '#2ecc71', update: '#f39c12', delete: '#e74c3c', replace: '#9b59b6', 'no-op': '#5a6a7a'
}

function SummaryConfirmDialog({
  title,
  summary,
  changes,
  onConfirm,
  onCancel
}: {
  title: string
  summary: { create: number; update: number; delete: number; replace: number; noop: number }
  changes?: TerraformPlanChange[]
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="tf-confirm-overlay" onClick={onCancel}>
      <div className="tf-confirm-dialog wide" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="tf-summary">
          <span className="tf-summary-item"><span className="tf-summary-count create">{summary.create}</span> create</span>
          <span className="tf-summary-item"><span className="tf-summary-count update">{summary.update}</span> update</span>
          <span className="tf-summary-item"><span className="tf-summary-count delete">{summary.delete}</span> delete</span>
          <span className="tf-summary-item"><span className="tf-summary-count replace">{summary.replace}</span> replace</span>
        </div>
        {changes && changes.length > 0 && (
          <div className="tf-change-list">
            {changes.filter(c => c.actionLabel !== 'no-op').map((c) => (
              <div key={c.address} className="tf-change-item">
                <span className="tf-change-action" style={{ color: ACTION_COLORS[c.actionLabel] ?? '#9ca7b7' }}>
                  {c.actionLabel === 'create' ? '+' : c.actionLabel === 'delete' ? '-' : c.actionLabel === 'update' ? '~' : '±'} {c.actionLabel}
                </span>
                <span className="tf-change-address">{c.address}</span>
                <span className="tf-change-type">{c.type}</span>
              </div>
            ))}
          </div>
        )}
        <p style={{ margin: 0, fontSize: 12, color: '#9ca7b7' }}>Review the changes above before proceeding.</p>
        <div className="tf-inputs-buttons">
          <button type="button" className="tf-toolbar-btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="tf-toolbar-btn accent" onClick={onConfirm}>Continue</button>
        </div>
      </div>
    </div>
  )
}

/* ── Diagram Component ────────────────────────────────────── */

const NODE_W = 260
const NODE_H = 44
const LAYER_GAP_X = 100
const SLOT_GAP_Y = 18

/* Colour palette – action types get vivid fills so create/delete/update
   are obvious at a glance, while "existing resource" stays muted. */
const CATEGORY_STYLE: Record<string, { fill: string; stroke: string; text: string; badge: string }> = {
  create:     { fill: '#15352a', stroke: '#2ecc71', text: '#5ef5a0', badge: '+ create' },
  update:     { fill: '#352b15', stroke: '#f39c12', text: '#ffd080', badge: '~ update' },
  delete:     { fill: '#351919', stroke: '#e74c3c', text: '#ff9e8e', badge: '- delete' },
  replace:    { fill: '#2b1535', stroke: '#9b59b6', text: '#d3a4f0', badge: 'replace' },
  'no-op':    { fill: '#1e232b', stroke: '#3b4350', text: '#8898a8', badge: '' },
  resource:   { fill: '#1e232b', stroke: '#4a8fe7', text: '#a0c4f0', badge: '' },
  dependency: { fill: '#1e232b', stroke: '#5a6a7a', text: '#8898a8', badge: '' },
  config:     { fill: '#1e232b', stroke: '#5a6a7a', text: '#8898a8', badge: '' },
}

const EDGE_COLORS: Record<string, string> = {
  depends_on: 'rgba(74,143,231,0.55)',
  reference:  'rgba(223,105,42,0.40)',
  inferred:   'rgba(155,89,182,0.40)',
}

function styleFor(category: string) {
  return CATEGORY_STYLE[category] ?? CATEGORY_STYLE.resource
}

/* ── Layered layout with crossing minimisation ────────────── */

function computeLayout(diagram: TerraformDiagram): {
  positions: Map<string, { x: number; y: number; layer: number; slot: number }>
  layers: string[][]
  width: number
  height: number
} {
  type Pos = { x: number; y: number; layer: number; slot: number }
  const positions = new Map<string, Pos>()
  if (diagram.nodes.length === 0) return { positions, layers: [], width: 500, height: 300 }

  const ids = new Set(diagram.nodes.map((n) => n.id))
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()
  for (const n of diagram.nodes) { incoming.set(n.id, new Set()); outgoing.set(n.id, new Set()) }
  for (const e of diagram.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    incoming.get(e.to)!.add(e.from)
    outgoing.get(e.from)!.add(e.to)
  }

  /* 1 ── longest-path layer assignment ─────────────────── */
  const depth = new Map<string, number>()
  function walk(id: string, visited: Set<string>): number {
    if (depth.has(id)) return depth.get(id)!
    if (visited.has(id)) return 0 // cycle guard
    visited.add(id)
    let maxParent = -1
    for (const p of incoming.get(id) ?? []) maxParent = Math.max(maxParent, walk(p, visited))
    const d = maxParent + 1
    depth.set(id, d)
    return d
  }
  for (const n of diagram.nodes) walk(n.id, new Set())

  const maxLayer = Math.max(0, ...Array.from(depth.values()))
  const layers: string[][] = Array.from({ length: maxLayer + 1 }, () => [])
  for (const n of diagram.nodes) layers[depth.get(n.id) ?? 0].push(n.id)

  /* 2 ── barycentric ordering (reduces crossings) ──────── */
  for (let pass = 0; pass < 4; pass++) {
    for (let li = 1; li <= maxLayer; li++) {
      const layer = layers[li]
      const bary = new Map<string, number>()
      for (const id of layer) {
        const parents = [...(incoming.get(id) ?? [])]
          .map((p) => layers[depth.get(p) ?? 0].indexOf(p))
          .filter((i) => i >= 0)
        bary.set(id, parents.length > 0 ? parents.reduce((a, b) => a + b, 0) / parents.length : 0)
      }
      layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0))
    }
    // reverse pass
    for (let li = maxLayer - 1; li >= 0; li--) {
      const layer = layers[li]
      const bary = new Map<string, number>()
      for (const id of layer) {
        const children = [...(outgoing.get(id) ?? [])]
          .map((c) => layers[depth.get(c) ?? 0].indexOf(c))
          .filter((i) => i >= 0)
        bary.set(id, children.length > 0 ? children.reduce((a, b) => a + b, 0) / children.length : 0)
      }
      layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0))
    }
  }

  /* 3 ── position each node on the canvas ──────────────── */
  const PAD = 30
  let maxSlotCount = 0
  for (let li = 0; li <= maxLayer; li++) {
    maxSlotCount = Math.max(maxSlotCount, layers[li].length)
    for (let si = 0; si < layers[li].length; si++) {
      positions.set(layers[li][si], {
        x: PAD + li * (NODE_W + LAYER_GAP_X),
        y: PAD + si * (NODE_H + SLOT_GAP_Y),
        layer: li, slot: si
      })
    }
  }

  const width = PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * LAYER_GAP_X
  const height = PAD * 2 + maxSlotCount * NODE_H + (maxSlotCount - 1) * SLOT_GAP_Y
  return { positions, layers, width: Math.max(500, width), height: Math.max(300, height) }
}

/* SVG cubic-bezier edge that exits the right side of `from` and
   enters the left side of `to`, with smooth horizontal tangents.
   Port offsets are spread vertically when a node has many edges
   so lines don't pile on top of each other. */

function buildEdgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromPortOffset: number,
  toPortOffset: number
): string {
  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2 + fromPortOffset
  const x2 = to.x
  const y2 = to.y + NODE_H / 2 + toPortOffset

  if (x1 < x2) {
    // Normal left-to-right: smooth bezier
    const cx = (x1 + x2) / 2
    return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`
  }
  // Back edge (cycle or same-layer): route around
  const lift = 30
  const cx1 = x1 + 40
  const cx2 = x2 - 40
  const midY = Math.min(y1, y2) - lift - Math.abs(y1 - y2) * 0.15
  return `M${x1},${y1} C${cx1},${y1} ${cx1},${midY} ${(x1 + x2) / 2},${midY} S${cx2},${y2} ${x2},${y2}`
}

function DiagramView({ diagram }: { diagram: TerraformDiagram }) {
  const [zoom, setZoom] = useState(100)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })

  /* reset view when data changes */
  useEffect(() => { setZoom(100); setPan({ x: 0, y: 0 }) }, [diagram])

  const { positions, width, height } = useMemo(() => computeLayout(diagram), [diagram])

  /* ── mouse pan ─────────────────────────────────────────── */
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // only left button, and not on a control button
    if (e.button !== 0) return
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { ...pan }
    e.preventDefault()
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    const dx = e.clientX - dragStart.current.x
    const dy = e.clientY - dragStart.current.y
    setPan({ x: panStart.current.x + dx, y: panStart.current.y + dy })
  }, [])

  const handleMouseUp = useCallback(() => {
    dragging.current = false
  }, [])

  /* stop drag if mouse leaves the window entirely */
  useEffect(() => {
    const stop = () => { dragging.current = false }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  /* ── disable wheel zoom – only buttons control zoom ──── */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
  }, [])

  function handleResetView() {
    setZoom(100)
    setPan({ x: 0, y: 0 })
  }

  /* pre-compute port offsets so that multiple edges from/to a single
     node spread out vertically instead of overlapping */
  const portOffsets = useMemo(() => {
    const outCount = new Map<string, number>()
    const inCount = new Map<string, number>()
    const outIdx = new Map<string, number>()
    const inIdx = new Map<string, number>()
    for (const e of diagram.edges) {
      outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1)
      inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1)
    }
    const offsets: Array<{ fromOff: number; toOff: number }> = []
    const SPREAD = 4
    for (const e of diagram.edges) {
      const oTotal = outCount.get(e.from) ?? 1
      const oI = outIdx.get(e.from) ?? 0
      outIdx.set(e.from, oI + 1)
      const iTotal = inCount.get(e.to) ?? 1
      const iI = inIdx.get(e.to) ?? 0
      inIdx.set(e.to, iI + 1)
      offsets.push({
        fromOff: (oI - (oTotal - 1) / 2) * SPREAD,
        toOff:   (iI - (iTotal - 1) / 2) * SPREAD
      })
    }
    return offsets
  }, [diagram.edges])

  /* build the set of edge ids connected to the hovered node */
  const connectedEdges = useMemo(() => {
    if (!hoveredNode) return null
    const set = new Set<number>()
    diagram.edges.forEach((e, i) => {
      if (e.from === hoveredNode || e.to === hoveredNode) set.add(i)
    })
    return set
  }, [hoveredNode, diagram.edges])

  const connectedNodes = useMemo(() => {
    if (!hoveredNode) return null
    const set = new Set<string>([hoveredNode])
    for (const e of diagram.edges) {
      if (e.from === hoveredNode) set.add(e.to)
      if (e.to === hoveredNode) set.add(e.from)
    }
    return set
  }, [hoveredNode, diagram.edges])

  if (diagram.nodes.length === 0) {
    return <div className="tf-diagram-container"><div className="tf-diagram-empty">No resources to display. Run Plan or load state to build the diagram.</div></div>
  }

  const scale = zoom / 100

  /* Category legend entries */
  const legendEntries = Array.from(
    new Map(diagram.nodes.map((n) => [n.category, styleFor(n.category)])).entries()
  ).filter(([cat]) => CATEGORY_STYLE[cat]?.badge || ['resource', 'dependency'].includes(cat))

  return (
    <div
      ref={containerRef}
      className={`tf-diagram-container ${fullscreen ? 'fullscreen' : ''}`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      style={{ cursor: dragging.current ? 'grabbing' : 'grab' }}
    >
      <div className="tf-diagram-controls">
        <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? 'Exit' : 'Full'}</button>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setZoom((z) => Math.max(15, z - 15))}>-</button>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={handleResetView}>{zoom}%</button>
        <button onMouseDown={(e) => e.stopPropagation()} onClick={() => setZoom((z) => Math.min(400, z + 15))}>+</button>
      </div>
      {/* colour legend */}
      <div className="tf-diagram-legend" onMouseDown={(e) => e.stopPropagation()}>
        {legendEntries.map(([cat, s]) => (
          <span key={cat} className="tf-diagram-legend-item">
            <span className="tf-diagram-legend-swatch" style={{ background: s.stroke }} />
            {s.badge || cat}
          </span>
        ))}
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.depends_on }} />depends_on</span>
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.reference }} />reference</span>
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.inferred }} />inferred</span>
      </div>
      <svg
        className="tf-diagram-svg"
        viewBox={`0 0 ${width} ${height}`}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
          transformOrigin: '0 0',
          width,
          height,
          userSelect: 'none'
        }}
      >
        <defs>
          {/* Coloured arrowheads for each relation type */}
          <marker id="tf-arr-depends_on" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.depends_on} />
          </marker>
          <marker id="tf-arr-reference" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.reference} />
          </marker>
          <marker id="tf-arr-inferred" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.inferred} />
          </marker>
        </defs>

        {/* ── edges ── */}
        {diagram.edges.map((edge, i) => {
          const from = positions.get(edge.from)
          const to = positions.get(edge.to)
          if (!from || !to) return null
          const { fromOff, toOff } = portOffsets[i]
          const d = buildEdgePath(from, to, fromOff, toOff)
          const color = EDGE_COLORS[edge.relation] ?? EDGE_COLORS.depends_on
          const dimmed = connectedEdges && !connectedEdges.has(i)
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={dimmed ? 1 : 1.5}
              strokeDasharray={edge.relation === 'inferred' ? '6,3' : undefined}
              markerEnd={`url(#tf-arr-${edge.relation in EDGE_COLORS ? edge.relation : 'depends_on'})`}
              opacity={dimmed ? 0.12 : 1}
              style={{ transition: 'opacity 0.15s' }}
            />
          )
        })}

        {/* ── nodes ── */}
        {diagram.nodes.map((node) => {
          const pos = positions.get(node.id)
          if (!pos) return null
          const s = styleFor(node.category)
          const dimmed = connectedNodes && !connectedNodes.has(node.id)
          const label = node.id
          const badgeText = s.badge
          return (
            <g
              key={node.id}
              transform={`translate(${pos.x},${pos.y})`}
              opacity={dimmed ? 0.25 : 1}
              style={{ transition: 'opacity 0.15s', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredNode(node.id)}
              onMouseLeave={() => setHoveredNode(null)}
            >
              <rect width={NODE_W} height={NODE_H} rx="6" fill={s.fill} stroke={s.stroke} strokeWidth="1.5" />
              {/* Action badge (top-right corner) */}
              {badgeText && (
                <>
                  <rect x={NODE_W - 62} y={4} width={56} height={16} rx="3" fill={s.stroke} opacity={0.85} />
                  <text x={NODE_W - 34} y={15} fill="#0f1114" fontSize="9" fontWeight="700" textAnchor="middle" fontFamily="system-ui">{badgeText}</text>
                </>
              )}
              {/* Resource address – full text, clipped to node width */}
              <clipPath id={`clip-${node.id.replace(/[^a-zA-Z0-9]/g, '_')}`}>
                <rect x="8" y="0" width={badgeText ? NODE_W - 72 : NODE_W - 16} height={NODE_H} />
              </clipPath>
              <text
                x={10} y={badgeText ? NODE_H / 2 + 5 : NODE_H / 2 + 4}
                fill={s.text} fontSize="11" fontFamily='"Cascadia Code","Fira Code",monospace'
                clipPath={`url(#clip-${node.id.replace(/[^a-zA-Z0-9]/g, '_')})`}
              >
                {label}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* ── Actions Tab ──────────────────────────────────────────── */

function ActionsTab({
  project,
  cliOk,
  running,
  lastLog,
  onInit,
  onPlan,
  onApply,
  onDestroy
}: {
  project: TerraformProject
  cliOk: boolean
  running: boolean
  lastLog: TerraformCommandLog | null
  onInit: () => void
  onPlan: () => void
  onApply: () => void
  onDestroy: () => void
}) {
  const [outputOpen, setOutputOpen] = useState(false)
  const s = project.lastPlanSummary

  return (
    <>
      <div className="tf-section">
        <h3>Actions</h3>
        <div className="tf-actions-grid">
          <button className="tf-action-btn init" disabled={!cliOk || running} onClick={onInit}>Init</button>
          <button className="tf-action-btn plan" disabled={!cliOk || running} onClick={onPlan}>Plan</button>
          <button className="tf-action-btn apply" disabled={!cliOk || running} onClick={onApply}>Apply</button>
          <button className="tf-action-btn destroy" disabled={!cliOk || running} onClick={onDestroy}>Destroy</button>
        </div>
      </div>
      {(s.create > 0 || s.update > 0 || s.delete > 0 || s.replace > 0) && (
        <div className="tf-section">
          <div className="tf-summary">
            <span className="tf-summary-item"><span className="tf-summary-count create">{s.create}</span> create</span>
            <span className="tf-summary-item"><span className="tf-summary-count update">{s.update}</span> update</span>
            <span className="tf-summary-item"><span className="tf-summary-count delete">{s.delete}</span> delete</span>
            <span className="tf-summary-item"><span className="tf-summary-count replace">{s.replace}</span> replace</span>
            <span className="tf-summary-item"><span className="tf-summary-count" style={{ color: '#5a6a7a' }}>{s.noop}</span> no-op</span>
          </div>
        </div>
      )}
      <div className="tf-section">
        <h3>Infrastructure Diagram</h3>
        <DiagramView diagram={project.diagram} />
      </div>
      {project.actionRows.length > 0 && (
        <div className="tf-section">
          <h3>Action Table</h3>
          <div className="tf-action-table-wrap">
            <table className="tf-data-table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Action</th>
                  <th>Address</th>
                  <th>ResourceType</th>
                  <th>PhysicalResourceId</th>
                </tr>
              </thead>
              <tbody>
                {project.actionRows.map((row) => (
                  <tr key={row.order}>
                    <td>{row.order}</td>
                    <td>
                      <span className={`tf-summary-count ${row.action}`}>{row.action}</span>
                    </td>
                    <td title={row.address}>{row.address}</td>
                    <td>{row.resourceType}</td>
                    <td title={row.physicalResourceId}>{row.physicalResourceId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="tf-section">
        <button className="tf-output-toggle" onClick={() => setOutputOpen(!outputOpen)}>
          {outputOpen ? '▼' : '▶'} Command Output
          {lastLog && (
            <span style={{ fontWeight: 400, color: lastLog.success ? '#2ecc71' : lastLog.success === false ? '#e74c3c' : '#9ca7b7' }}>
              {' '}({lastLog.command}{lastLog.success !== null ? (lastLog.success ? ' ok' : ' failed') : ' running'})
            </span>
          )}
        </button>
        {outputOpen && lastLog && (
          <div className="tf-output-panel">{lastLog.output || '(no output)'}</div>
        )}
      </div>
    </>
  )
}

/* ── Resources Tab ────────────────────────────────────────── */

function ResourcesTab({ project }: { project: TerraformProject }) {
  const rows = project.resourceRows
  return (
    <>
      <div className="tf-section">
        <div className="tf-summary">
          <span className="tf-summary-item"><span className="tf-summary-count" style={{ color: '#4a8fe7' }}>{rows.length}</span> resources</span>
          <span className="tf-summary-item">source: {project.stateSource || 'none'}</span>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="tf-section"><div className="tf-empty">No deployed resources found. Run Init + Apply or load state.</div></div>
      ) : (
        <div className="tf-section">
          <div className="tf-resource-table-wrap">
            <table className="tf-data-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Address</th>
                  <th>Type</th>
                  <th>Arn</th>
                  <th>Region</th>
                  <th>ChangedBy</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.address}>
                    <td>{row.category}</td>
                    <td title={row.address}>{row.address}</td>
                    <td>{row.type}</td>
                    <td title={row.arn}>{row.arn ? (row.arn.length > 40 ? '...' + row.arn.slice(-38) : row.arn) : '-'}</td>
                    <td>{row.region || '-'}</td>
                    <td>{row.changedBy || '-'}</td>
                    <td title={row.tags}>{row.tags ? (row.tags.length > 40 ? row.tags.slice(0, 38) + '...' : row.tags) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}

/* ── Main Terraform Console ───────────────────────────────── */

const DRIFT_STATUS_LABELS: Record<Exclude<TerraformDriftStatus, 'unsupported'>, string> = {
  in_sync: 'In Sync',
  drifted: 'Drifted',
  missing_in_aws: 'Missing In AWS',
  unmanaged_in_aws: 'Unmanaged In AWS'
}

function driftItemKey(item: TerraformDriftItem): string {
  return `${item.terraformAddress}|${item.resourceType}|${item.cloudIdentifier}|${item.logicalName}|${item.status}`
}

function DriftTab({
  report,
  loading,
  error,
  statusFilter,
  typeFilter,
  selectedKey,
  onStatusFilterChange,
  onTypeFilterChange,
  onSelectItem,
  onRefresh,
  onOpenConsole,
  onRunStateShow
}: {
  report: TerraformDriftReport | null
  loading: boolean
  error: string
  statusFilter: 'all' | Exclude<TerraformDriftStatus, 'unsupported'>
  typeFilter: string
  selectedKey: string
  onStatusFilterChange: (value: 'all' | Exclude<TerraformDriftStatus, 'unsupported'>) => void
  onTypeFilterChange: (value: string) => void
  onSelectItem: (key: string) => void
  onRefresh: () => void
  onOpenConsole: (item: TerraformDriftItem) => void
  onRunStateShow: (item: TerraformDriftItem) => void
}) {
  const items = report?.items ?? []
  const resourceTypes = useMemo(
    () => report?.summary.resourceTypeCounts.map((entry) => entry.resourceType) ?? [],
    [report]
  )
  const filteredItems = useMemo(
    () => items.filter((item) =>
      (statusFilter === 'all' || item.status === statusFilter) &&
      (typeFilter === 'all' || item.resourceType === typeFilter)
    ),
    [items, statusFilter, typeFilter]
  )
  const selectedItem = useMemo(
    () => filteredItems.find((item) => driftItemKey(item) === selectedKey) ?? filteredItems[0] ?? null,
    [filteredItems, selectedKey]
  )

  return (
    <>
      <div className="tf-section">
        <div className="tf-section-head">
          <div>
            <h3>Drift Summary</h3>
            <div className="tf-section-hint">
              Terraform state vs live AWS inventory for region {report?.region ?? '-'}.
            </div>
          </div>
          <button type="button" className="tf-toolbar-btn" onClick={onRefresh} disabled={loading}>
            {loading ? 'Scanning...' : 'Refresh Drift'}
          </button>
        </div>
        {report && (
          <div className="tf-summary">
            <span className="tf-summary-item"><span className="tf-summary-count">{report.summary.total}</span> total</span>
            <span className="tf-summary-item"><span className="tf-summary-count drifted">{report.summary.statusCounts.drifted}</span> drifted</span>
            <span className="tf-summary-item"><span className="tf-summary-count missing_in_aws">{report.summary.statusCounts.missing_in_aws}</span> missing</span>
            <span className="tf-summary-item"><span className="tf-summary-count unmanaged_in_aws">{report.summary.statusCounts.unmanaged_in_aws}</span> unmanaged</span>
            <span className="tf-summary-item"><span className="tf-summary-count in_sync">{report.summary.statusCounts.in_sync}</span> in sync</span>
            <span className="tf-summary-item">scanned: {report.summary.scannedAt ? new Date(report.summary.scannedAt).toLocaleString() : '-'}</span>
          </div>
        )}
        <div className="tf-drift-filters">
          <div className="tf-drift-status-row">
            <button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => onStatusFilterChange('all')}>All</button>
            {(Object.keys(DRIFT_STATUS_LABELS) as Array<Exclude<TerraformDriftStatus, 'unsupported'>>).map((status) => (
              <button key={status} type="button" className={statusFilter === status ? 'active' : ''} onClick={() => onStatusFilterChange(status)}>
                {DRIFT_STATUS_LABELS[status]}
              </button>
            ))}
          </div>
          <label className="tf-drift-filter-select">
            <span>Type</span>
            <select value={typeFilter} onChange={(event) => onTypeFilterChange(event.target.value)}>
              <option value="all">All resource types</option>
              {resourceTypes.map((resourceType) => (
                <option key={resourceType} value={resourceType}>{resourceType}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {error && <div className="tf-section"><div className="tf-msg error">{error}</div></div>}
      {!loading && !error && filteredItems.length === 0 && (
        <div className="tf-section"><div className="tf-empty">No drift items matched the current filters.</div></div>
      )}
      {filteredItems.length > 0 && (
        <>
          <div className="tf-section">
            <div className="tf-resource-table-wrap">
              <table className="tf-data-table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Type</th>
                    <th>Logical Name</th>
                    <th>Terraform Address</th>
                    <th>Cloud Identifier</th>
                    <th>Region</th>
                    <th>Explanation</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => {
                    const key = driftItemKey(item)
                    return (
                      <tr key={key} className={selectedItem && driftItemKey(selectedItem) === key ? 'active' : ''} onClick={() => onSelectItem(key)}>
                        <td><span className={`tf-drift-badge ${item.status}`}>{DRIFT_STATUS_LABELS[item.status as Exclude<TerraformDriftStatus, 'unsupported'>]}</span></td>
                        <td>{item.resourceType}</td>
                        <td>{item.logicalName || '-'}</td>
                        <td title={item.terraformAddress}>{item.terraformAddress || '-'}</td>
                        <td title={item.cloudIdentifier}>{item.cloudIdentifier || '-'}</td>
                        <td>{item.region || '-'}</td>
                        <td title={item.explanation}>{item.explanation}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          {selectedItem && (
            <div className="tf-section">
              <div className="tf-section-head">
                <h3>Selected Drift Item</h3>
                <div className="tf-drift-actions">
                  <button type="button" className="tf-toolbar-btn" onClick={() => onOpenConsole(selectedItem)} disabled={!selectedItem.consoleUrl}>Open In AWS Console</button>
                  <button type="button" className="tf-toolbar-btn" onClick={() => onRunStateShow(selectedItem)} disabled={!selectedItem.terminalCommand}>terraform state show</button>
                </div>
              </div>
              <div className="tf-kv">
                <div className="tf-kv-row"><div className="tf-kv-label">Status</div><div className="tf-kv-value">{DRIFT_STATUS_LABELS[selectedItem.status as Exclude<TerraformDriftStatus, 'unsupported'>]}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Resource Type</div><div className="tf-kv-value">{selectedItem.resourceType}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Logical Name</div><div className="tf-kv-value">{selectedItem.logicalName || '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Terraform Address</div><div className="tf-kv-value">{selectedItem.terraformAddress || '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Cloud Identifier</div><div className="tf-kv-value">{selectedItem.cloudIdentifier || '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Region</div><div className="tf-kv-value">{selectedItem.region || '-'}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Explanation</div><div className="tf-kv-value">{selectedItem.explanation}</div></div>
                <div className="tf-kv-row"><div className="tf-kv-label">Suggested Next Step</div><div className="tf-kv-value">{selectedItem.suggestedNextStep}</div></div>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}

export function TerraformConsole({ connection, onRunTerminalCommand }: { connection: AwsConnection; onRunTerminalCommand?: (command: string) => void }) {
  const [cliInfo, setCliInfo] = useState<TerraformCliInfo | null>(null)
  const [projects, setProjectsList] = useState<TerraformProjectListItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detail, setDetail] = useState<TerraformProject | null>(null)
  const [detailTab, setDetailTab] = useState<DetailTab>('actions')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState('')
  const [lastLog, setLastLog] = useState<TerraformCommandLog | null>(null)
  const [driftReport, setDriftReport] = useState<TerraformDriftReport | null>(null)
  const [driftLoading, setDriftLoading] = useState(false)
  const [driftError, setDriftError] = useState('')
  const [driftStatusFilter, setDriftStatusFilter] = useState<'all' | Exclude<TerraformDriftStatus, 'unsupported'>>('all')
  const [driftTypeFilter, setDriftTypeFilter] = useState('all')
  const [selectedDriftKey, setSelectedDriftKey] = useState('')

  // Dialogs
  const [showInputs, setShowInputs] = useState(false)
  const [prefillMissing, setPrefillMissing] = useState<string[]>([])
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string; description: string; confirmWord: string; onConfirm: () => void
  } | null>(null)
  const [summaryDialog, setSummaryDialog] = useState<{
    title: string; summary: TerraformProject['lastPlanSummary']; changes?: TerraformPlanChange[]; onConfirm: () => void
  } | null>(null)

  // Progress overlay
  const [progressLine, setProgressLine] = useState('')
  const [showProgress, setShowProgress] = useState(false)
  const [progressItems, setProgressItems] = useState<Map<string, { status: string; done: boolean }>>(new Map())

  const cliOk = cliInfo?.found === true

  // Detect CLI on mount
  useEffect(() => {
    void detectCli().then(setCliInfo).catch(() => {
      setCliInfo({ found: false, path: '', version: '', error: 'Failed to detect Terraform CLI.' })
    })
  }, [])

  // Reset state when profile changes
  useEffect(() => {
    setSelectedId('')
    setDetail(null)
    setProjectsList([])
    setDriftReport(null)
    setDriftError('')
    setSelectedDriftKey('')
  }, [connection.profile])

  // Load projects
  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await listProjects(connection.profile)
      setProjectsList(list)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [connection.profile])

  useEffect(() => { void reload() }, [reload])

  // Load detail when selected
  useEffect(() => {
    if (!selectedId) { setDetail(null); setDriftReport(null); return }
    void getProject(connection.profile, selectedId).then((p) => {
      setDetail(p)
      setDriftReport(null)
      setDriftError('')
      setSelectedDriftKey('')
      void setSelectedProjectId(connection.profile, selectedId)
    }).catch(() => setDetail(null))
  }, [selectedId, connection.profile])

  const loadDrift = useCallback(async () => {
    if (!detail) return
    setDriftLoading(true)
    setDriftError('')
    try {
      const report = await getDrift(connection.profile, detail.id, connection)
      setDriftReport(report)
      setSelectedDriftKey((current) => current || (report.items[0] ? driftItemKey(report.items[0]) : ''))
    } catch (err) {
      setDriftError(err instanceof Error ? err.message : String(err))
    } finally {
      setDriftLoading(false)
    }
  }, [connection, detail])

  useEffect(() => {
    if (detailTab !== 'drift' || !detail) return
    if (driftReport?.projectId === detail.id && driftReport.region === connection.region) return
    void loadDrift()
  }, [connection.region, detail, detailTab, driftReport, loadDrift])

  // Subscribe to terraform events
  useEffect(() => {
    function handleEvent(event: unknown) {
      const e = event as Record<string, unknown>
      if (e.type === 'completed') {
        setRunning(false)
        setShowProgress(false)
        setProgressItems(new Map())
        const log = e.log as TerraformCommandLog
        setLastLog(log)
        if (e.project) setDetail(e.project as TerraformProject)
        void reload()
      } else if (e.type === 'started') {
        setRunning(true)
        setShowProgress(true)
        setProgressLine('Starting...')
        setProgressItems(new Map())
        setLastLog(e.log as TerraformCommandLog)
      } else if (e.type === 'progress') {
        const raw = typeof e.raw === 'string' ? e.raw : ''
        if (raw) setProgressLine(raw)
        const address = typeof e.address === 'string' ? e.address : ''
        const status = typeof e.status === 'string' ? e.status : ''
        if (address) {
          setProgressItems(prev => {
            const next = new Map(prev)
            const done = /complete|error/i.test(status)
            next.set(address, { status, done })
            return next
          })
        }
      } else if (e.type === 'output') {
        // Update last log output live
        setLastLog((prev) => {
          if (!prev) return prev
          return { ...prev, output: prev.output + (e.chunk as string) }
        })
      }
    }
    subscribe(handleEvent)
    return () => unsubscribe(handleEvent)
  }, [reload])

  // Handlers
  async function handleAddProject() {
    const dir = await chooseProjectDirectory()
    if (!dir) return
    try {
      const project = await addProject(connection.profile, dir)
      await reload()
      setSelectedId(project.id)
      setMsg('')
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemoveProject() {
    if (!selectedId) return
    try {
      await removeProject(connection.profile, selectedId)
      setSelectedId('')
      setDetail(null)
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleReload() {
    if (!selectedId) { await reload(); return }
    try {
      const p = await reloadProject(connection.profile, selectedId)
      setDetail(p)
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  function handleShowInputs() {
    if (!detail) return
    setPrefillMissing([])
    setShowInputs(true)
  }

  async function handleSaveInputs(variables: Record<string, unknown>, varFile: string) {
    if (!detail) return
    try {
      const updated = await updateInputs(connection.profile, detail.id, variables, varFile)
      setDetail(updated)
      setShowInputs(false)
      setPrefillMissing([])
      await reload()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    }
  }

  async function execCommand(command: 'init' | 'plan' | 'apply' | 'destroy'): Promise<TerraformCommandLog | null> {
    if (!detail || running) return null
    setMsg('')
    try {
      const log = await runCommand({ profileName: connection.profile, projectId: detail.id, command })
      // Handle missing vars
      if (!log.success && log.output) {
        const { missing, invalid } = await detectMissingVars(log.output)
        const unresolved = uniqueStrings([...missing, ...invalid])
        if (unresolved.length > 0) {
          setPrefillMissing(unresolved)
          setMsg(
            unresolved.length === 1
              ? `Missing required Terraform variable: ${unresolved[0]}. The Inputs dialog is open so you can provide it.`
              : `Missing required Terraform variables: ${unresolved.join(', ')}. The Inputs dialog is open so you can provide them.`
          )
          setShowInputs(true)
          return log
        }
      }
      return log
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
      return null
    }
  }

  function handleInit() { void execCommand('init') }
  function handlePlan() {
    void execCommand('plan').then(() => {
      setDetailTab('actions')
    })
  }

  function handleApply() {
    if (!detail) return
    if (!detail.hasSavedPlan) {
      // Need to plan first
      setMsg('Running Plan first...')
      void execCommand('plan').then((planLog) => {
        if (!planLog) return
        if (!planLog.success) {
          setMsg('Plan failed. Review Command Output and fix the Terraform error before applying.')
          return
        }
        void getProject(connection.profile, detail.id).then((p) => {
          setDetail(p)
          const fallbackSummary = parsePlanSummaryFromOutput(planLog.output)
          const summary = (
            p.lastPlanSummary.create +
            p.lastPlanSummary.update +
            p.lastPlanSummary.delete +
            p.lastPlanSummary.replace
          ) > 0 ? p.lastPlanSummary : (fallbackSummary ?? p.lastPlanSummary)
          const changeCount =
            summary.create +
            summary.update +
            summary.delete +
            summary.replace
          if (planLog.exitCode === 0 || changeCount === 0) {
            setMsg('No changes to apply.')
            return
          }
          setSummaryDialog({
              title: 'Apply Changes — Review',
              summary,
              changes: p.planChanges,
              onConfirm: () => {
                setSummaryDialog(null)
                setConfirmDialog({
                  title: 'Confirm Apply',
                  description: `You are about to apply ${summary.create} create, ${summary.update} update, ${summary.delete} delete, ${summary.replace} replace. This action cannot be easily undone.`,
                  confirmWord: 'APPLY',
                  onConfirm: () => {
                    setConfirmDialog(null)
                    void execCommand('apply')
                  }
                })
              }
            })
        }).catch((err) => {
          setMsg(err instanceof Error ? err.message : String(err))
        })
      })
      return
    }
    // Has saved plan - go directly to summary with resource list
    setSummaryDialog({
      title: 'Apply Changes — Review',
      summary: detail.lastPlanSummary,
      changes: detail.planChanges,
      onConfirm: () => {
        setSummaryDialog(null)
        setConfirmDialog({
          title: 'Confirm Apply',
          description: `You are about to apply ${detail.lastPlanSummary.create} create, ${detail.lastPlanSummary.update} update, ${detail.lastPlanSummary.delete} delete, ${detail.lastPlanSummary.replace} replace. This action cannot be easily undone.`,
          confirmWord: 'APPLY',
          onConfirm: () => {
            setConfirmDialog(null)
            void execCommand('apply')
          }
        })
      }
    })
  }

  function handleDestroy() {
    if (!detail) return
    // First confirmation: show what will be destroyed
    const destroySummary = { create: 0, update: 0, delete: detail.stateAddresses.length, replace: 0, noop: 0 }
    const destroyChanges: TerraformPlanChange[] = detail.stateAddresses.map(addr => {
      const parts = addr.split('.')
      return { address: addr, type: parts[0] ?? addr, name: parts.slice(1).join('.'), modulePath: '', provider: '', actions: ['delete'], actionLabel: 'delete' }
    })
    setSummaryDialog({
      title: 'Destroy Infrastructure — Review',
      summary: destroySummary,
      changes: destroyChanges,
      onConfirm: () => {
        setSummaryDialog(null)
        // Second confirmation: typed
        setConfirmDialog({
          title: 'Confirm Destroy',
          description: `This will permanently destroy ${detail.stateAddresses.length} managed resource${detail.stateAddresses.length !== 1 ? 's' : ''}. This cannot be undone.`,
          confirmWord: 'DESTROY',
          onConfirm: () => {
            setConfirmDialog(null)
            void execCommand('destroy')
          }
        })
      }
    })
  }

  function handleOpenDriftConsole(item: TerraformDriftItem) {
    if (!item.consoleUrl) return
    void openExternalUrl(item.consoleUrl)
  }

  function handleRunDriftStateShow(item: TerraformDriftItem) {
    if (!item.terminalCommand) return
    onRunTerminalCommand?.(item.terminalCommand)
    setMsg('Terraform state command opened in terminal')
  }

  return (
    <div className="tf-console">
      {/* CLI Banner */}
      {cliInfo && !cliInfo.found && (
        <div className="tf-cli-banner">{cliInfo.error || 'Terraform CLI not found. Please install Terraform.'}</div>
      )}
      {cliInfo?.found && (
        <div className="tf-cli-banner success">Terraform {cliInfo.version} ({cliInfo.path})</div>
      )}

      {/* Toolbar */}
      <div className="tf-toolbar">
        <button className="tf-toolbar-btn accent" onClick={handleAddProject} disabled={!cliOk}>Add Project</button>
        <button className="tf-toolbar-btn danger" onClick={handleRemoveProject} disabled={!selectedId}>Remove Project</button>
        <button className="tf-toolbar-btn" onClick={handleReload} disabled={loading}>Reload</button>
        <button className="tf-toolbar-btn" onClick={handleShowInputs} disabled={!detail}>Inputs</button>
      </div>

      {msg && <div className={`tf-msg ${msg.toLowerCase().includes('error') || msg.toLowerCase().includes('not found') ? 'error' : ''}`}>{msg}</div>}

      {/* Main Layout */}
      <div className="tf-main-layout">
        {/* Left: Project Table */}
        <div className="tf-project-table-area">
          {projects.length === 0 ? (
            <div className="tf-empty">No projects added. Click Add Project to get started.</div>
          ) : (
            <table className="tf-data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>State</th>
                  <th>Resources</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr
                    key={p.id}
                    className={p.id === selectedId ? 'active' : ''}
                    onClick={() => setSelectedId(p.id)}
                  >
                    <td>{p.name}</td>
                    <td title={p.rootPath}>{p.rootPath.length > 30 ? '...' + p.rootPath.slice(-28) : p.rootPath}</td>
                    <td><span className={`tf-status-badge ${p.status?.toLowerCase() ?? 'ready'}`}>{p.status ?? 'Ready'}</span></td>
                    <td>{(p as unknown as TerraformProject).stateSource ?? '-'}</td>
                    <td>{p.inventory?.length ?? p.metadata?.resourceCount ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Right: Detail Pane */}
        <div className="tf-detail-pane">
          {!detail ? (
            <div className="tf-empty" style={{ padding: 24 }}>Select a project to view details.</div>
          ) : (
            <>
              {/* Detail tabs */}
              <div className="tf-detail-tabs">
                <button className={detailTab === 'actions' ? 'active' : ''} onClick={() => setDetailTab('actions')}>Actions</button>
                <button className={detailTab === 'resources' ? 'active' : ''} onClick={() => setDetailTab('resources')}>Resources</button>
                <button className={detailTab === 'drift' ? 'active' : ''} onClick={() => setDetailTab('drift')}>Drift</button>
              </div>

              {/* Project info */}
              <div className="tf-section">
                <div className="tf-kv">
                  <div className="tf-kv-row"><div className="tf-kv-label">Name</div><div className="tf-kv-value">{detail.name}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Path</div><div className="tf-kv-value">{detail.rootPath}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Backend</div><div className="tf-kv-value">{detail.metadata.backendType}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Providers</div><div className="tf-kv-value">{detail.metadata.providerNames.join(', ') || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">TF Files</div><div className="tf-kv-value">{detail.metadata.tfFileCount}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Resources</div><div className="tf-kv-value">{detail.metadata.resourceCount}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Variables</div><div className="tf-kv-value">{detail.metadata.variableCount}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">Var File</div><div className="tf-kv-value">{detail.varFile || '-'}</div></div>
                  <div className="tf-kv-row"><div className="tf-kv-label">State Source</div><div className="tf-kv-value">{detail.stateSource || 'none'}</div></div>
                </div>
              </div>

              {detailTab === 'actions' && (
                <ActionsTab
                  project={detail}
                  cliOk={cliOk}
                  running={running}
                lastLog={lastLog}
                onInit={handleInit}
                onPlan={handlePlan}
                onApply={handleApply}
                onDestroy={handleDestroy}
              />
              )}
              {detailTab === 'resources' && <ResourcesTab project={detail} />}
              {detailTab === 'drift' && (
                <DriftTab
                  report={driftReport}
                  loading={driftLoading}
                  error={driftError}
                  statusFilter={driftStatusFilter}
                  typeFilter={driftTypeFilter}
                  selectedKey={selectedDriftKey}
                  onStatusFilterChange={setDriftStatusFilter}
                  onTypeFilterChange={setDriftTypeFilter}
                  onSelectItem={setSelectedDriftKey}
                  onRefresh={() => void loadDrift()}
                  onOpenConsole={handleOpenDriftConsole}
                  onRunStateShow={handleRunDriftStateShow}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Inputs Dialog */}
      {showInputs && detail && (
        <InputsDialog
          project={detail}
          onSave={handleSaveInputs}
          onClose={() => { setShowInputs(false); setPrefillMissing([]) }}
          prefillMissing={prefillMissing.length > 0 ? prefillMissing : undefined}
        />
      )}

      {/* Summary Confirm Dialog */}
      {summaryDialog && (
        <SummaryConfirmDialog
          title={summaryDialog.title}
          summary={summaryDialog.summary}
          changes={summaryDialog.changes}
          onConfirm={summaryDialog.onConfirm}
          onCancel={() => setSummaryDialog(null)}
        />
      )}

      {/* Typed Confirm Dialog */}
      {confirmDialog && (
        <TypedConfirmDialog
          title={confirmDialog.title}
          description={confirmDialog.description}
          confirmWord={confirmDialog.confirmWord}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {/* Progress Overlay */}
      {showProgress && (
        <div className="tf-progress-overlay">
          <h4><span className="tf-progress-spinner" /> Running Terraform...</h4>
          <div className="tf-progress-line">{progressLine}</div>
          {progressItems.size > 0 && (
            <div className="tf-progress-items">
              {[...progressItems.entries()].map(([addr, info]) => (
                <div key={addr} className={`tf-progress-item ${info.done ? 'done' : 'active'}`}>
                  <span className="tf-progress-item-status" style={{ color: /error/i.test(info.status) ? '#e74c3c' : info.done ? '#2ecc71' : '#f39c12' }}>
                    {info.done ? (/error/i.test(info.status) ? '✗' : '✓') : '⟳'}
                  </span>
                  <span className="tf-progress-item-addr">{addr}</span>
                  <span className="tf-progress-item-label">{info.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
