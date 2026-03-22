import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AwsConnection, CloudFormationStackSummary, CloudFormationResourceSummary } from '@shared/types'
import { listCloudFormationStackResources, listCloudFormationStacks } from './api'

type CfnTab = 'stacks' | 'diagram'
type StackColKey = 'stackName' | 'status' | 'creationTime'
type ResColKey = 'logicalResourceId' | 'physicalResourceId' | 'resourceType' | 'resourceStatus'

const STACK_COLS: { key: StackColKey; label: string; color: string }[] = [
  { key: 'stackName', label: 'StackName', color: '#3b82f6' },
  { key: 'status', label: 'Status', color: '#22c55e' },
  { key: 'creationTime', label: 'Created', color: '#f59e0b' },
]

const RES_COLS: { key: ResColKey; label: string; color: string }[] = [
  { key: 'logicalResourceId', label: 'LogicalId', color: '#3b82f6' },
  { key: 'physicalResourceId', label: 'PhysicalId', color: '#14b8a6' },
  { key: 'resourceType', label: 'Type', color: '#8b5cf6' },
  { key: 'resourceStatus', label: 'Status', color: '#22c55e' },
]

function fmtTs(v: string) { return v && v !== '-' ? new Date(v).toLocaleString() : '-' }

/* ── Diagram helpers ─────────────────────────────────────── */

type DiagramNode = { id: string; label: string; category: string }
type DiagramEdge = { from: string; to: string; relation: string }
type Diagram = { nodes: DiagramNode[]; edges: DiagramEdge[] }

const NODE_W = 260
const NODE_H = 44
const LAYER_GAP_X = 100
const SLOT_GAP_Y = 18

const CFN_CATEGORY_STYLE: Record<string, { fill: string; stroke: string; text: string }> = {
  compute:     { fill: '#15352a', stroke: '#2ecc71', text: '#5ef5a0' },
  network:     { fill: '#1a2840', stroke: '#4a8fe7', text: '#a0c4f0' },
  storage:     { fill: '#352b15', stroke: '#f39c12', text: '#ffd080' },
  security:    { fill: '#2b1535', stroke: '#9b59b6', text: '#d3a4f0' },
  database:    { fill: '#351919', stroke: '#e74c3c', text: '#ff9e8e' },
  application: { fill: '#153535', stroke: '#1abc9c', text: '#76d7c4' },
  default:     { fill: '#1e232b', stroke: '#4a8fe7', text: '#a0c4f0' },
}

const EDGE_COLORS: Record<string, string> = {
  contains:  'rgba(74,143,231,0.55)',
  uses:      'rgba(223,105,42,0.40)',
  secures:   'rgba(155,89,182,0.40)',
}

function categorizeResource(type: string): string {
  const t = type.toLowerCase()
  if (t.includes('instance') || t.includes('function') || t.includes('task') || t.includes('autoscaling') || t.includes('launchtemplate')) return 'compute'
  if (t.includes('vpc') || t.includes('subnet') || t.includes('route') || t.includes('internetgateway') || t.includes('natgateway') || t.includes('networkinterface') || t.includes('eip') || t.includes('loadbalancer') || t.includes('listener') || t.includes('targetgroup')) return 'network'
  if (t.includes('bucket') || t.includes('volume') || t.includes('filesystem')) return 'storage'
  if (t.includes('securitygroup') || t.includes('role') || t.includes('policy') || t.includes('certificate') || t.includes('waf') || t.includes('key')) return 'security'
  if (t.includes('dbinstance') || t.includes('dbcluster') || t.includes('dynamodb') || t.includes('rds') || t.includes('table')) return 'database'
  if (t.includes('queue') || t.includes('topic') || t.includes('subscription') || t.includes('api') || t.includes('stage') || t.includes('deployment')) return 'application'
  return 'default'
}

function cfnStyleFor(category: string) {
  return CFN_CATEGORY_STYLE[category] ?? CFN_CATEGORY_STYLE.default
}

/* Known CloudFormation resource dependency patterns:
   We infer edges from resource types since CF doesn't expose dependencies in the resource list API. */
const CFN_DEPENDENCY_RULES: Array<{ parent: RegExp; child: RegExp; relation: string }> = [
  { parent: /VPC$/i,             child: /Subnet$/i,                  relation: 'contains' },
  { parent: /VPC$/i,             child: /SecurityGroup$/i,           relation: 'contains' },
  { parent: /VPC$/i,             child: /RouteTable$/i,              relation: 'contains' },
  { parent: /VPC$/i,             child: /InternetGateway|VPCGatewayAttachment/i, relation: 'contains' },
  { parent: /VPC$/i,             child: /NatGateway$/i,              relation: 'contains' },
  { parent: /Subnet$/i,          child: /Instance$/i,                relation: 'contains' },
  { parent: /Subnet$/i,          child: /NatGateway$/i,              relation: 'contains' },
  { parent: /Subnet$/i,          child: /DBInstance$/i,              relation: 'contains' },
  { parent: /RouteTable$/i,      child: /Route$/i,                   relation: 'contains' },
  { parent: /SecurityGroup$/i,   child: /Instance$/i,                relation: 'secures' },
  { parent: /SecurityGroup$/i,   child: /LoadBalancer$/i,            relation: 'secures' },
  { parent: /SecurityGroup$/i,   child: /DBInstance$/i,              relation: 'secures' },
  { parent: /SecurityGroup$/i,   child: /Function$/i,                relation: 'secures' },
  { parent: /Role$/i,            child: /Instance$/i,                relation: 'uses' },
  { parent: /Role$/i,            child: /Function$/i,                relation: 'uses' },
  { parent: /Role$/i,            child: /TaskDefinition$/i,          relation: 'uses' },
  { parent: /Policy$/i,          child: /Role$/i,                    relation: 'uses' },
  { parent: /LoadBalancer$/i,    child: /Listener$/i,                relation: 'contains' },
  { parent: /Listener$/i,        child: /TargetGroup$/i,             relation: 'uses' },
  { parent: /TargetGroup$/i,     child: /Instance$/i,                relation: 'uses' },
  { parent: /AutoScalingGroup$/i,child: /LaunchTemplate|LaunchConfiguration/i, relation: 'uses' },
  { parent: /Bucket$/i,          child: /BucketPolicy$/i,            relation: 'contains' },
  { parent: /Topic$/i,           child: /Subscription$/i,            relation: 'contains' },
  { parent: /RestApi|HttpApi$/i,  child: /Stage$/i,                  relation: 'contains' },
  { parent: /RestApi|HttpApi$/i,  child: /Deployment$/i,             relation: 'contains' },
  { parent: /DBSubnetGroup$/i,   child: /DBInstance$/i,              relation: 'uses' },
  { parent: /DBCluster$/i,       child: /DBInstance$/i,              relation: 'contains' },
]

function buildDiagramFromResources(resources: CloudFormationResourceSummary[]): Diagram {
  const nodes: DiagramNode[] = resources.map(r => ({
    id: r.logicalResourceId,
    label: r.resourceType.replace(/^AWS::/, ''),
    category: categorizeResource(r.resourceType),
  }))

  const edges: DiagramEdge[] = []
  for (let i = 0; i < resources.length; i++) {
    for (let j = 0; j < resources.length; j++) {
      if (i === j) continue
      for (const rule of CFN_DEPENDENCY_RULES) {
        if (rule.parent.test(resources[i].resourceType) && rule.child.test(resources[j].resourceType)) {
          edges.push({
            from: resources[i].logicalResourceId,
            to: resources[j].logicalResourceId,
            relation: rule.relation,
          })
          break
        }
      }
    }
  }

  return { nodes, edges }
}

/* ── Layered layout with crossing minimisation ────────────── */

function computeLayout(diagram: Diagram): {
  positions: Map<string, { x: number; y: number; layer: number; slot: number }>
  width: number
  height: number
} {
  type Pos = { x: number; y: number; layer: number; slot: number }
  const positions = new Map<string, Pos>()
  if (diagram.nodes.length === 0) return { positions, width: 500, height: 300 }

  const ids = new Set(diagram.nodes.map(n => n.id))
  const incoming = new Map<string, Set<string>>()
  const outgoing = new Map<string, Set<string>>()
  for (const n of diagram.nodes) { incoming.set(n.id, new Set()); outgoing.set(n.id, new Set()) }
  for (const e of diagram.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue
    incoming.get(e.to)!.add(e.from)
    outgoing.get(e.from)!.add(e.to)
  }

  /* longest-path layer assignment */
  const depth = new Map<string, number>()
  function walk(id: string, visited: Set<string>): number {
    if (depth.has(id)) return depth.get(id)!
    if (visited.has(id)) return 0
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

  /* barycentric ordering */
  for (let pass = 0; pass < 4; pass++) {
    for (let li = 1; li <= maxLayer; li++) {
      const layer = layers[li]
      const bary = new Map<string, number>()
      for (const id of layer) {
        const parents = [...(incoming.get(id) ?? [])].map(p => layers[depth.get(p) ?? 0].indexOf(p)).filter(i => i >= 0)
        bary.set(id, parents.length > 0 ? parents.reduce((a, b) => a + b, 0) / parents.length : 0)
      }
      layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0))
    }
    for (let li = maxLayer - 1; li >= 0; li--) {
      const layer = layers[li]
      const bary = new Map<string, number>()
      for (const id of layer) {
        const children = [...(outgoing.get(id) ?? [])].map(c => layers[depth.get(c) ?? 0].indexOf(c)).filter(i => i >= 0)
        bary.set(id, children.length > 0 ? children.reduce((a, b) => a + b, 0) / children.length : 0)
      }
      layer.sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0))
    }
  }

  /* position nodes */
  const PAD = 30
  let maxSlotCount = 0
  for (let li = 0; li <= maxLayer; li++) {
    maxSlotCount = Math.max(maxSlotCount, layers[li].length)
    for (let si = 0; si < layers[li].length; si++) {
      positions.set(layers[li][si], { x: PAD + li * (NODE_W + LAYER_GAP_X), y: PAD + si * (NODE_H + SLOT_GAP_Y), layer: li, slot: si })
    }
  }

  const width = PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * LAYER_GAP_X
  const height = PAD * 2 + maxSlotCount * NODE_H + (maxSlotCount - 1) * SLOT_GAP_Y
  return { positions, width: Math.max(500, width), height: Math.max(300, height) }
}

function buildEdgePath(from: { x: number; y: number }, to: { x: number; y: number }, fromPortOffset: number, toPortOffset: number): string {
  const x1 = from.x + NODE_W
  const y1 = from.y + NODE_H / 2 + fromPortOffset
  const x2 = to.x
  const y2 = to.y + NODE_H / 2 + toPortOffset
  if (x1 < x2) {
    const cx = (x1 + x2) / 2
    return `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`
  }
  const lift = 30
  const cx1 = x1 + 40
  const cx2 = x2 - 40
  const midY = Math.min(y1, y2) - lift - Math.abs(y1 - y2) * 0.15
  return `M${x1},${y1} C${cx1},${y1} ${cx1},${midY} ${(x1 + x2) / 2},${midY} S${cx2},${y2} ${x2},${y2}`
}

/* ── CfnDiagramView ──────────────────────────────────────── */

function CfnDiagramView({ diagram }: { diagram: Diagram }) {
  const [zoom, setZoom] = useState(100)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  const [hoveredNode, setHoveredNode] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const panStart = useRef({ x: 0, y: 0 })

  useEffect(() => { setZoom(100); setPan({ x: 0, y: 0 }) }, [diagram])

  const { positions, width, height } = useMemo(() => computeLayout(diagram), [diagram])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return
    dragging.current = true
    dragStart.current = { x: e.clientX, y: e.clientY }
    panStart.current = { ...pan }
    e.preventDefault()
  }, [pan])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return
    setPan({ x: panStart.current.x + (e.clientX - dragStart.current.x), y: panStart.current.y + (e.clientY - dragStart.current.y) })
  }, [])

  const handleMouseUp = useCallback(() => { dragging.current = false }, [])

  useEffect(() => {
    const stop = () => { dragging.current = false }
    window.addEventListener('mouseup', stop)
    return () => window.removeEventListener('mouseup', stop)
  }, [])

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const cx = e.clientX - rect.left
    const cy = e.clientY - rect.top
    const oldScale = zoom / 100
    const delta = e.deltaY > 0 ? -10 : 10
    const newZoom = Math.min(400, Math.max(15, zoom + delta))
    const newScale = newZoom / 100
    setPan({ x: cx - (cx - pan.x) * (newScale / oldScale), y: cy - (cy - pan.y) * (newScale / oldScale) })
    setZoom(newZoom)
  }, [zoom, pan])

  const portOffsets = useMemo(() => {
    const outCount = new Map<string, number>()
    const inCount = new Map<string, number>()
    const outIdx = new Map<string, number>()
    const inIdx = new Map<string, number>()
    for (const e of diagram.edges) { outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1); inCount.set(e.to, (inCount.get(e.to) ?? 0) + 1) }
    const offsets: Array<{ fromOff: number; toOff: number }> = []
    const SPREAD = 4
    for (const e of diagram.edges) {
      const oTotal = outCount.get(e.from) ?? 1; const oI = outIdx.get(e.from) ?? 0; outIdx.set(e.from, oI + 1)
      const iTotal = inCount.get(e.to) ?? 1; const iI = inIdx.get(e.to) ?? 0; inIdx.set(e.to, iI + 1)
      offsets.push({ fromOff: (oI - (oTotal - 1) / 2) * SPREAD, toOff: (iI - (iTotal - 1) / 2) * SPREAD })
    }
    return offsets
  }, [diagram.edges])

  const connectedEdges = useMemo(() => {
    if (!hoveredNode) return null
    const set = new Set<number>()
    diagram.edges.forEach((e, i) => { if (e.from === hoveredNode || e.to === hoveredNode) set.add(i) })
    return set
  }, [hoveredNode, diagram.edges])

  const connectedNodes = useMemo(() => {
    if (!hoveredNode) return null
    const set = new Set<string>([hoveredNode])
    for (const e of diagram.edges) { if (e.from === hoveredNode) set.add(e.to); if (e.to === hoveredNode) set.add(e.from) }
    return set
  }, [hoveredNode, diagram.edges])

  if (diagram.nodes.length === 0) {
    return <div className="tf-diagram-container"><div className="tf-diagram-empty">Select a stack to view its resource diagram.</div></div>
  }

  const scale = zoom / 100

  const legendCategories = Array.from(new Set(diagram.nodes.map(n => n.category)))
  const nodeMap = new Map(diagram.nodes.map(n => [n.id, n]))

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
        <button onMouseDown={e => e.stopPropagation()} onClick={() => setFullscreen(!fullscreen)}>{fullscreen ? 'Exit' : 'Full'}</button>
        <button onMouseDown={e => e.stopPropagation()} onClick={() => setZoom(z => Math.max(15, z - 15))}>-</button>
        <button onMouseDown={e => e.stopPropagation()} onClick={() => { setZoom(100); setPan({ x: 0, y: 0 }) }}>{zoom}%</button>
        <button onMouseDown={e => e.stopPropagation()} onClick={() => setZoom(z => Math.min(400, z + 15))}>+</button>
      </div>
      <div className="tf-diagram-legend" onMouseDown={e => e.stopPropagation()}>
        {legendCategories.map(cat => {
          const s = cfnStyleFor(cat)
          return <span key={cat} className="tf-diagram-legend-item"><span className="tf-diagram-legend-swatch" style={{ background: s.stroke }} />{cat}</span>
        })}
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.contains }} />contains</span>
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.uses }} />uses</span>
        <span className="tf-diagram-legend-item"><span className="tf-diagram-legend-line" style={{ background: EDGE_COLORS.secures }} />secures</span>
      </div>
      <svg
        className="tf-diagram-svg"
        viewBox={`0 0 ${width} ${height}`}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, transformOrigin: '0 0', width, height, userSelect: 'none' }}
      >
        <defs>
          <marker id="cfn-arr-contains" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.contains} />
          </marker>
          <marker id="cfn-arr-uses" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.uses} />
          </marker>
          <marker id="cfn-arr-secures" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto" markerUnits="userSpaceOnUse">
            <polygon points="0,0 10,3.5 0,7" fill={EDGE_COLORS.secures} />
          </marker>
        </defs>

        {diagram.edges.map((edge, i) => {
          const from = positions.get(edge.from)
          const to = positions.get(edge.to)
          if (!from || !to) return null
          const { fromOff, toOff } = portOffsets[i]
          const d = buildEdgePath(from, to, fromOff, toOff)
          const color = EDGE_COLORS[edge.relation] ?? EDGE_COLORS.contains
          const dimmed = connectedEdges && !connectedEdges.has(i)
          return (
            <path key={i} d={d} fill="none" stroke={color} strokeWidth={dimmed ? 1 : 1.5}
              markerEnd={`url(#cfn-arr-${edge.relation in EDGE_COLORS ? edge.relation : 'contains'})`}
              opacity={dimmed ? 0.12 : 1} style={{ transition: 'opacity 0.15s' }}
            />
          )
        })}

        {diagram.nodes.map(node => {
          const pos = positions.get(node.id)
          if (!pos) return null
          const s = cfnStyleFor(node.category)
          const dimmed = connectedNodes && !connectedNodes.has(node.id)
          const nodeData = nodeMap.get(node.id)
          const typeLabel = nodeData?.label ?? ''
          return (
            <g key={node.id} transform={`translate(${pos.x},${pos.y})`} opacity={dimmed ? 0.25 : 1}
              style={{ transition: 'opacity 0.15s', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredNode(node.id)} onMouseLeave={() => setHoveredNode(null)}
            >
              <rect width={NODE_W} height={NODE_H} rx="6" fill={s.fill} stroke={s.stroke} strokeWidth="1.5" />
              {/* Type badge (top-right) */}
              <rect x={NODE_W - 62} y={4} width={56} height={16} rx="3" fill={s.stroke} opacity={0.85} />
              <text x={NODE_W - 34} y={15} fill="#0f1114" fontSize="8" fontWeight="700" textAnchor="middle" fontFamily="system-ui">{node.category}</text>
              {/* Logical ID */}
              <clipPath id={`cfn-clip-${node.id.replace(/[^a-zA-Z0-9]/g, '_')}`}>
                <rect x="8" y="0" width={NODE_W - 72} height={NODE_H / 2} />
              </clipPath>
              <text x={10} y={18} fill={s.text} fontSize="11" fontWeight="600"
                fontFamily='"Cascadia Code","Fira Code",monospace'
                clipPath={`url(#cfn-clip-${node.id.replace(/[^a-zA-Z0-9]/g, '_')})`}
              >{node.id}</text>
              {/* Resource type */}
              <clipPath id={`cfn-clip2-${node.id.replace(/[^a-zA-Z0-9]/g, '_')}`}>
                <rect x="8" y={NODE_H / 2} width={NODE_W - 16} height={NODE_H / 2} />
              </clipPath>
              <text x={10} y={36} fill={s.text} fontSize="9" opacity={0.6}
                fontFamily='"Cascadia Code","Fira Code",monospace'
                clipPath={`url(#cfn-clip2-${node.id.replace(/[^a-zA-Z0-9]/g, '_')})`}
              >{typeLabel}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/* ── Main Console ────────────────────────────────────────── */

export function CloudFormationConsole({ connection }: { connection: AwsConnection }) {
  const [tab, setTab] = useState<CfnTab>('stacks')
  const [stacks, setStacks] = useState<CloudFormationStackSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedStack, setSelectedStack] = useState('')
  const [resources, setResources] = useState<CloudFormationResourceSummary[]>([])
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [stackCols, setStackCols] = useState<Set<StackColKey>>(() => new Set(STACK_COLS.map(c => c.key)))
  const [resCols, setResCols] = useState<Set<ResColKey>>(() => new Set(RES_COLS.map(c => c.key)))

  async function load(stackName?: string) {
    setError('')
    setLoading(true)
    try {
      const nextStacks = await listCloudFormationStacks(connection)
      setStacks(nextStacks)
      const resolved = stackName ?? selectedStack ?? nextStacks[0]?.stackName ?? ''
      setSelectedStack(resolved)
      setResources(resolved ? await listCloudFormationStackResources(connection, resolved) : [])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [connection.profile, connection.region])

  const visStackCols = STACK_COLS.filter(c => stackCols.has(c.key))
  const visResCols = RES_COLS.filter(c => resCols.has(c.key))

  const filteredStacks = useMemo(() => {
    if (!filter) return stacks
    const q = filter.toLowerCase()
    return stacks.filter(s => s.stackName.toLowerCase().includes(q) || s.status.toLowerCase().includes(q))
  }, [stacks, filter])

  const diagram = useMemo(() => buildDiagramFromResources(resources), [resources])

  function getStackVal(s: CloudFormationStackSummary, k: StackColKey) {
    if (k === 'creationTime') return fmtTs(s.creationTime)
    return s[k] ?? '-'
  }

  function getResVal(r: CloudFormationResourceSummary, k: ResColKey) {
    return r[k] ?? '-'
  }

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className={`svc-tab ${tab === 'stacks' ? 'active' : ''}`} type="button" onClick={() => setTab('stacks')}>Stacks</button>
        <button className={`svc-tab ${tab === 'diagram' ? 'active' : ''}`} type="button" onClick={() => setTab('diagram')}>Diagram</button>
        <button className="svc-tab right" type="button" onClick={() => void load()}>Refresh</button>
      </div>

      {error && <div className="svc-error">{error}</div>}

      {tab === 'stacks' && (
        <>
          <input className="svc-search" placeholder="Filter stacks..." value={filter} onChange={e => setFilter(e.target.value)} />

          <div className="svc-chips">
            {STACK_COLS.map(col => (
              <button
                key={col.key}
                className={`svc-chip ${stackCols.has(col.key) ? 'active' : ''}`}
                type="button"
                style={stackCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
                onClick={() => setStackCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
              >{col.label}</button>
            ))}
          </div>

          <div className="svc-layout">
            <div className="svc-table-area">
              <table className="svc-table">
                <thead><tr>{visStackCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
                <tbody>
                  {loading && <tr><td colSpan={visStackCols.length}>Gathering data</td></tr>}
                  {!loading && filteredStacks.map(s => (
                    <tr key={s.stackName} className={s.stackName === selectedStack ? 'active' : ''} onClick={() => void load(s.stackName)}>
                      {visStackCols.map(c => (
                        <td key={c.key}>
                          {c.key === 'status' ? <span className={`svc-badge ${s.status.includes('COMPLETE') ? 'ok' : s.status.includes('PROGRESS') ? 'warn' : s.status.includes('FAILED') ? 'danger' : 'muted'}`}>{s.status}</span> : getStackVal(s, c.key)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!filteredStacks.length && !loading && <div className="svc-empty">No stacks found.</div>}
            </div>

            <div className="svc-sidebar">
              <div className="svc-section">
                <h3>Resources ({resources.length})</h3>
                <div className="svc-chips" style={{ marginBottom: 10 }}>
                  {RES_COLS.map(col => (
                    <button
                      key={col.key}
                      className={`svc-chip ${resCols.has(col.key) ? 'active' : ''}`}
                      type="button"
                      style={resCols.has(col.key) ? { background: col.color, borderColor: col.color } : undefined}
                      onClick={() => setResCols(p => { const n = new Set(p); n.has(col.key) ? n.delete(col.key) : n.add(col.key); return n })}
                    >{col.label}</button>
                  ))}
                </div>
                <div style={{ maxHeight: 'calc(100vh - 440px)', overflow: 'auto' }}>
                  <table className="svc-table">
                    <thead><tr>{visResCols.map(c => <th key={c.key}>{c.label}</th>)}</tr></thead>
                    <tbody>
                      {resources.map(r => (
                        <tr key={`${r.logicalResourceId}-${r.physicalResourceId}`}>
                          {visResCols.map(c => (
                            <td key={c.key}>
                              {c.key === 'resourceStatus' ? <span className={`svc-badge ${r.resourceStatus.includes('COMPLETE') ? 'ok' : r.resourceStatus.includes('PROGRESS') ? 'warn' : r.resourceStatus.includes('FAILED') ? 'danger' : 'muted'}`}>{r.resourceStatus}</span> : getResVal(r, c.key)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!resources.length && <div className="svc-empty">Select a stack to view resources.</div>}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'diagram' && (
        <>
          <div className="svc-chips" style={{ marginBottom: 10 }}>
            {stacks.map(s => (
              <button
                key={s.stackName}
                className={`svc-chip ${selectedStack === s.stackName ? 'active' : ''}`}
                type="button"
                style={selectedStack === s.stackName ? { background: '#4a8fe7', borderColor: '#4a8fe7' } : undefined}
                onClick={() => void load(s.stackName)}
              >{s.stackName}</button>
            ))}
          </div>
          <CfnDiagramView diagram={diagram} />
        </>
      )}
    </div>
  )
}
