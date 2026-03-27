import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AwsConnection,
  CloudFormationChangeSetDetail,
  CloudFormationChangeSetSummary,
  CloudFormationDriftedResourceRow,
  CloudFormationResourceSummary,
  CloudFormationStackDriftSummary,
  CloudFormationStackSummary
} from '@shared/types'
import {
  createCloudFormationChangeSet,
  deleteCloudFormationChangeSet,
  executeCloudFormationChangeSet,
  getCloudFormationChangeSetDetail,
  getCloudFormationDriftDetectionStatus,
  getCloudFormationDriftSummary,
  listCloudFormationChangeSets,
  listCloudFormationStackResources,
  listCloudFormationStacks,
  startCloudFormationDriftDetection
} from './api'
import { ConfirmButton } from './ConfirmButton'

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

  /* disable wheel zoom – only buttons control zoom */
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
  }, [])

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

type StackDetailTab = 'resources' | 'change-sets' | 'drift'
type ChangeSetTemplateMode = 'existing' | 'body' | 'url'

function badgeClass(value: string): string {
  const normalized = value.toLowerCase()
  if (normalized.includes('complete') || normalized.includes('available') || normalized === 'in_sync' || normalized === 'execute_complete') return 'ok'
  if (normalized.includes('progress') || normalized.includes('pending') || normalized.includes('review') || normalized.includes('unavailable')) return 'warn'
  if (normalized.includes('fail') || normalized.includes('delete') || normalized.includes('obsolete') || normalized === 'drifted' || normalized === 'modified') return 'danger'
  if (normalized.includes('not_checked') || normalized.includes('unsupported') || normalized.includes('unknown') || normalized === 'not_started') return 'muted'
  return 'active'
}

function safePretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseChangeSetParameters(input: string): Array<{
  parameterKey: string
  parameterValue?: string
  usePreviousValue?: boolean
}> {
  const trimmed = input.trim()
  if (!trimmed) return []

  const parsed = JSON.parse(trimmed) as unknown
  if (!Array.isArray(parsed)) {
    throw new Error('Parameters JSON must be an array.')
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Parameter at index ${index} must be an object.`)
    }

    const record = item as Record<string, unknown>
    const parameterKey = typeof record.parameterKey === 'string'
      ? record.parameterKey
      : typeof record.ParameterKey === 'string'
        ? record.ParameterKey
        : ''

    if (!parameterKey) {
      throw new Error(`Parameter at index ${index} is missing parameterKey.`)
    }

    return {
      parameterKey,
      parameterValue: typeof record.parameterValue === 'string'
        ? record.parameterValue
        : typeof record.ParameterValue === 'string'
          ? record.ParameterValue
          : undefined,
      usePreviousValue: typeof record.usePreviousValue === 'boolean'
        ? record.usePreviousValue
        : typeof record.UsePreviousValue === 'boolean'
          ? record.UsePreviousValue
          : undefined
    }
  })
}

function parseCapabilities(input: string): string[] {
  return input.split(',').map((value) => value.trim()).filter(Boolean)
}

function RawJsonBlock({ title, json }: { title: string; json: string }) {
  return (
    <details style={{ marginTop: 12 }}>
      <summary style={{ cursor: 'pointer', color: '#9ca7b7', fontSize: 12 }}>{title}</summary>
      <pre className="svc-code" style={{ marginTop: 10 }}>{json}</pre>
    </details>
  )
}

export function CloudFormationConsole({ connection }: { connection: AwsConnection }) {
  const [tab, setTab] = useState<CfnTab>('stacks')
  const [detailTab, setDetailTab] = useState<StackDetailTab>('resources')
  const [stacks, setStacks] = useState<CloudFormationStackSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [changeSetDetailLoading, setChangeSetDetailLoading] = useState(false)
  const [driftLoading, setDriftLoading] = useState(false)
  const [selectedStack, setSelectedStack] = useState('')
  const [resources, setResources] = useState<CloudFormationResourceSummary[]>([])
  const [changeSets, setChangeSets] = useState<CloudFormationChangeSetSummary[]>([])
  const [selectedChangeSetName, setSelectedChangeSetName] = useState('')
  const [selectedChangeSetDetail, setSelectedChangeSetDetail] = useState<CloudFormationChangeSetDetail | null>(null)
  const [driftSummary, setDriftSummary] = useState<CloudFormationStackDriftSummary | null>(null)
  const [driftRows, setDriftRows] = useState<CloudFormationDriftedResourceRow[]>([])
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [stackCols, setStackCols] = useState<Set<StackColKey>>(() => new Set(STACK_COLS.map(c => c.key)))
  const [resCols, setResCols] = useState<Set<ResColKey>>(() => new Set(RES_COLS.map(c => c.key)))
  const [createError, setCreateError] = useState('')
  const [templateMode, setTemplateMode] = useState<ChangeSetTemplateMode>('existing')
  const [changeSetName, setChangeSetName] = useState('')
  const [changeSetDescription, setChangeSetDescription] = useState('')
  const [templateBody, setTemplateBody] = useState('')
  const [templateUrl, setTemplateUrl] = useState('')
  const [parametersJson, setParametersJson] = useState('')
  const [capabilitiesInput, setCapabilitiesInput] = useState('CAPABILITY_NAMED_IAM')

  const loadChangeSetDetail = useCallback(async (stackName: string, nextChangeSetName: string) => {
    if (!stackName || !nextChangeSetName) {
      setSelectedChangeSetDetail(null)
      return
    }

    setChangeSetDetailLoading(true)
    try {
      const detail = await getCloudFormationChangeSetDetail(connection, stackName, nextChangeSetName)
      setSelectedChangeSetDetail(detail)
    } catch (reason) {
      setSelectedChangeSetDetail(null)
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setChangeSetDetailLoading(false)
    }
  }, [connection])

  const loadStackDetail = useCallback(async (stackName: string) => {
    if (!stackName) {
      setResources([])
      setChangeSets([])
      setSelectedChangeSetName('')
      setSelectedChangeSetDetail(null)
      setDriftSummary(null)
      setDriftRows([])
      return
    }

    setDetailLoading(true)
    setError('')
    try {
      const [nextResources, nextChangeSets, nextDriftSummary] = await Promise.all([
        listCloudFormationStackResources(connection, stackName),
        listCloudFormationChangeSets(connection, stackName),
        getCloudFormationDriftSummary(connection, stackName)
      ])

      setResources(nextResources)
      setChangeSets(nextChangeSets)
      setDriftSummary(nextDriftSummary)
      setDriftRows([])

      const nextSelectedChangeSet = nextChangeSets.find((item) => item.changeSetName === selectedChangeSetName)?.changeSetName
        ?? nextChangeSets[0]?.changeSetName
        ?? ''
      setSelectedChangeSetName(nextSelectedChangeSet)
      if (nextSelectedChangeSet) {
        void loadChangeSetDetail(stackName, nextSelectedChangeSet)
      } else {
        setSelectedChangeSetDetail(null)
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDetailLoading(false)
    }
  }, [connection, loadChangeSetDetail, selectedChangeSetName])

  const load = useCallback(async (stackName?: string) => {
    setError('')
    setLoading(true)
    try {
      const nextStacks = await listCloudFormationStacks(connection)
      setStacks(nextStacks)
      const resolved = stackName ?? selectedStack ?? nextStacks[0]?.stackName ?? ''
      setSelectedStack(resolved)
      await loadStackDetail(resolved)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [connection, loadStackDetail, selectedStack])

  useEffect(() => {
    void load()
  }, [connection.sessionId, connection.region, load])

  useEffect(() => {
    if (!driftSummary?.driftDetectionId || driftSummary.detectionStatus !== 'DETECTION_IN_PROGRESS') {
      return
    }

    const timer = window.setTimeout(async () => {
      setDriftLoading(true)
      try {
        const result = await getCloudFormationDriftDetectionStatus(connection, selectedStack, driftSummary.driftDetectionId)
        setDriftSummary(result.summary)
        setDriftRows(result.rows)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setDriftLoading(false)
      }
    }, 2500)

    return () => window.clearTimeout(timer)
  }, [connection, driftSummary, selectedStack])

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

  async function handleCreateChangeSet() {
    if (!selectedStack || !changeSetName.trim()) return

    setCreateError('')
    try {
      const created = await createCloudFormationChangeSet(connection, {
        stackName: selectedStack,
        changeSetName: changeSetName.trim(),
        description: changeSetDescription.trim() || undefined,
        usePreviousTemplate: templateMode === 'existing',
        templateBody: templateMode === 'body' ? templateBody : undefined,
        templateUrl: templateMode === 'url' ? templateUrl.trim() : undefined,
        capabilities: parseCapabilities(capabilitiesInput),
        parameters: parseChangeSetParameters(parametersJson)
      })

      await loadStackDetail(selectedStack)
      setSelectedChangeSetName(created.changeSetName)
      setChangeSetName('')
      setChangeSetDescription('')
      setTemplateBody('')
      setTemplateUrl('')
      setParametersJson('')
    } catch (reason) {
      setCreateError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  async function handleExecuteChangeSet(nextChangeSetName: string) {
    await executeCloudFormationChangeSet(connection, selectedStack, nextChangeSetName)
    await load(selectedStack)
  }

  async function handleDeleteChangeSet(nextChangeSetName: string) {
    await deleteCloudFormationChangeSet(connection, selectedStack, nextChangeSetName)
    await loadStackDetail(selectedStack)
  }

  async function handleRefreshDrift() {
    if (!selectedStack) return
    setDriftLoading(true)
    try {
      const summary = await getCloudFormationDriftSummary(connection, selectedStack)
      setDriftSummary(summary)
      if (summary.driftDetectionId && summary.detectionStatus === 'DETECTION_COMPLETE') {
        const result = await getCloudFormationDriftDetectionStatus(connection, selectedStack, summary.driftDetectionId)
        setDriftSummary(result.summary)
        setDriftRows(result.rows)
      } else {
        setDriftRows([])
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDriftLoading(false)
    }
  }

  async function handleStartDriftDetection() {
    if (!selectedStack) return
    setDriftLoading(true)
    try {
      const driftDetectionId = await startCloudFormationDriftDetection(connection, selectedStack)
      setDriftSummary((current) => ({
        stackName: current?.stackName ?? selectedStack,
        stackId: current?.stackId ?? '-',
        stackDriftStatus: current?.stackDriftStatus ?? 'NOT_CHECKED',
        detectionStatus: 'DETECTION_IN_PROGRESS',
        detectionStatusReason: '',
        driftDetectionId,
        lastCheckTimestamp: current?.lastCheckTimestamp ?? ''
      }))
      setDriftRows([])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setDriftLoading(false)
    }
  }

  return (
    <div className="svc-console">
      <div className="svc-tab-bar">
        <button className={`svc-tab ${tab === 'stacks' ? 'active' : ''}`} type="button" onClick={() => setTab('stacks')}>Stacks</button>
        <button className={`svc-tab ${tab === 'diagram' ? 'active' : ''}`} type="button" onClick={() => setTab('diagram')}>Diagram</button>
        <button className="svc-tab right" type="button" onClick={() => void load(selectedStack)}>Refresh</button>
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
                  {loading && <tr><td colSpan={Math.max(1, visStackCols.length)}>Gathering data</td></tr>}
                  {!loading && filteredStacks.map(s => (
                    <tr key={s.stackName} className={s.stackName === selectedStack ? 'active' : ''} onClick={() => { setSelectedStack(s.stackName); void loadStackDetail(s.stackName) }}>
                      {visStackCols.map(c => (
                        <td key={c.key}>
                          {c.key === 'status' ? <span className={`svc-badge ${badgeClass(s.status)}`}>{s.status}</span> : getStackVal(s, c.key)}
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
                <h3>{selectedStack || 'Stack Detail'}</h3>
                <div className="svc-kv">
                  <div className="svc-kv-row"><div className="svc-kv-label">Resources</div><div className="svc-kv-value">{resources.length}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Change Sets</div><div className="svc-kv-value">{changeSets.length}</div></div>
                  <div className="svc-kv-row"><div className="svc-kv-label">Drift</div><div className="svc-kv-value"><span className={`svc-badge ${badgeClass(driftSummary?.stackDriftStatus ?? 'NOT_CHECKED')}`}>{driftSummary?.stackDriftStatus ?? 'NOT_CHECKED'}</span></div></div>
                </div>
                {detailLoading && <div className="svc-section-hint" style={{ marginTop: 10 }}>Refreshing stack detail...</div>}
              </div>

              <div className="svc-side-tabs">
                <button className={detailTab === 'resources' ? 'active' : ''} type="button" onClick={() => setDetailTab('resources')}>Resources</button>
                <button className={detailTab === 'change-sets' ? 'active' : ''} type="button" onClick={() => setDetailTab('change-sets')}>Change Sets</button>
                <button className={detailTab === 'drift' ? 'active' : ''} type="button" onClick={() => setDetailTab('drift')}>Drift</button>
              </div>

              {detailTab === 'resources' && (
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
                                {c.key === 'resourceStatus' ? <span className={`svc-badge ${badgeClass(r.resourceStatus)}`}>{r.resourceStatus}</span> : getResVal(r, c.key)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!resources.length && <div className="svc-empty">Select a stack to view resources.</div>}
                  </div>
                </div>
              )}

              {detailTab === 'change-sets' && (
                <>
                  <div className="svc-section">
                    <h3>Create Change Set</h3>
                    {createError && <div className="svc-error" style={{ marginBottom: 10 }}>{createError}</div>}
                    <div className="svc-form">
                      <label><span>Name</span><input value={changeSetName} onChange={(event) => setChangeSetName(event.target.value)} placeholder="preview-update" /></label>
                      <label><span>Description</span><input value={changeSetDescription} onChange={(event) => setChangeSetDescription(event.target.value)} placeholder="Preview stack update" /></label>
                      <label><span>Template</span><select value={templateMode} onChange={(event) => setTemplateMode(event.target.value as ChangeSetTemplateMode)}><option value="existing">Use current stack template</option><option value="body">Paste template body</option><option value="url">Template URL</option></select></label>
                      {templateMode === 'body' && <label><span>Body</span><textarea value={templateBody} onChange={(event) => setTemplateBody(event.target.value)} placeholder="Paste YAML or JSON template body" /></label>}
                      {templateMode === 'url' && <label><span>Template URL</span><input value={templateUrl} onChange={(event) => setTemplateUrl(event.target.value)} placeholder="https://..." /></label>}
                      <label><span>Capabilities</span><input value={capabilitiesInput} onChange={(event) => setCapabilitiesInput(event.target.value)} placeholder="CAPABILITY_IAM,CAPABILITY_NAMED_IAM" /></label>
                      <label><span>Parameters JSON</span><textarea value={parametersJson} onChange={(event) => setParametersJson(event.target.value)} placeholder='[{"parameterKey":"ImageTag","parameterValue":"v2"}]' /></label>
                    </div>
                    <div className="svc-section-hint">Parameters must be JSON objects with `parameterKey`, `parameterValue`, and optional `usePreviousValue`.</div>
                    <div className="svc-btn-row" style={{ marginTop: 10 }}>
                      <button className="svc-btn primary" type="button" disabled={!selectedStack || !changeSetName.trim()} onClick={() => void handleCreateChangeSet()}>Create Change Set</button>
                    </div>
                  </div>

                  <div className="svc-section">
                    <h3>Change Sets ({changeSets.length})</h3>
                    {changeSets.length > 0 ? (
                      <div className="svc-list">
                        {changeSets.map((changeSet) => (
                          <button
                            key={changeSet.changeSetId || changeSet.changeSetName}
                            className={`svc-list-item ${selectedChangeSetName === changeSet.changeSetName ? 'active' : ''}`}
                            type="button"
                            onClick={() => {
                              setSelectedChangeSetName(changeSet.changeSetName)
                              void loadChangeSetDetail(selectedStack, changeSet.changeSetName)
                            }}
                          >
                            <div className="svc-list-title">{changeSet.changeSetName}</div>
                            <div className="svc-list-meta"><span className={`svc-badge ${badgeClass(changeSet.status)}`}>{changeSet.status}</span>{' '}<span className={`svc-badge ${badgeClass(changeSet.executionStatus)}`}>{changeSet.executionStatus}</span>{' '}{fmtTs(changeSet.creationTime)}</div>
                            <div className="svc-list-meta">{changeSet.description || changeSet.statusReason || 'No description.'}</div>
                          </button>
                        ))}
                      </div>
                    ) : <div className="svc-empty">No change sets found for this stack.</div>}
                  </div>

                  <div className="svc-section">
                    <h3>Change Set Detail</h3>
                    {changeSetDetailLoading && <div className="svc-empty">Loading change set detail...</div>}
                    {!changeSetDetailLoading && !selectedChangeSetDetail && <div className="svc-empty">Select a change set to inspect changes before execution.</div>}
                    {!changeSetDetailLoading && selectedChangeSetDetail && (
                      <>
                        <div className="svc-btn-row" style={{ marginBottom: 12 }}>
                          <ConfirmButton
                            className="svc-btn success"
                            confirmLabel="Confirm execute"
                            modalTitle={`Execute ${selectedChangeSetDetail.summary.changeSetName}`}
                            modalBody={`Execute change set ${selectedChangeSetDetail.summary.changeSetName} against stack ${selectedStack}? This will start the stack update immediately.`}
                            onConfirm={() => void handleExecuteChangeSet(selectedChangeSetDetail.summary.changeSetName)}
                            disabled={selectedChangeSetDetail.summary.status.toUpperCase().includes('FAILED')}
                          >
                            Execute Change Set
                          </ConfirmButton>
                          <ConfirmButton
                            className="svc-btn danger"
                            confirmLabel="Confirm delete"
                            modalTitle={`Delete ${selectedChangeSetDetail.summary.changeSetName}`}
                            modalBody={`Delete change set ${selectedChangeSetDetail.summary.changeSetName} for stack ${selectedStack}? This only removes the preview and cannot be undone.`}
                            onConfirm={() => void handleDeleteChangeSet(selectedChangeSetDetail.summary.changeSetName)}
                          >
                            Delete Change Set
                          </ConfirmButton>
                        </div>

                        <div className="svc-kv">
                          <div className="svc-kv-row"><div className="svc-kv-label">Status</div><div className="svc-kv-value"><span className={`svc-badge ${badgeClass(selectedChangeSetDetail.summary.status)}`}>{selectedChangeSetDetail.summary.status}</span></div></div>
                          <div className="svc-kv-row"><div className="svc-kv-label">Execution</div><div className="svc-kv-value"><span className={`svc-badge ${badgeClass(selectedChangeSetDetail.summary.executionStatus)}`}>{selectedChangeSetDetail.summary.executionStatus}</span></div></div>
                          <div className="svc-kv-row"><div className="svc-kv-label">Type</div><div className="svc-kv-value">{selectedChangeSetDetail.summary.changeSetType}</div></div>
                          <div className="svc-kv-row"><div className="svc-kv-label">Created</div><div className="svc-kv-value">{fmtTs(selectedChangeSetDetail.summary.creationTime)}</div></div>
                          <div className="svc-kv-row"><div className="svc-kv-label">Reason</div><div className="svc-kv-value">{selectedChangeSetDetail.summary.statusReason || '-'}</div></div>
                        </div>

                        <div style={{ marginTop: 14 }}>
                          <h4>Change Preview ({selectedChangeSetDetail.changes.length})</h4>
                          {selectedChangeSetDetail.changes.length > 0 ? (
                            <div className="svc-table-area" style={{ border: '1px solid #3b4350', borderRadius: 6, maxHeight: 260 }}>
                              <table className="svc-table">
                                <thead><tr><th>Action</th><th>Logical ID</th><th>Type</th><th>Replacement</th><th>Scope</th><th>Details</th></tr></thead>
                                <tbody>
                                  {selectedChangeSetDetail.changes.map((change, index) => (
                                    <tr key={`${change.logicalResourceId}-${index}`}>
                                      <td><span className={`svc-badge ${badgeClass(change.action)}`}>{change.action}</span></td>
                                      <td>{change.logicalResourceId}</td>
                                      <td>{change.resourceType}</td>
                                      <td>{change.replacement}</td>
                                      <td>{change.scope.join(', ') || '-'}</td>
                                      <td style={{ whiteSpace: 'pre-wrap', maxWidth: 420 }}>{change.details.join('\n') || '-'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : <div className="svc-empty">No change rows returned yet.</div>}
                        </div>

                        <div style={{ marginTop: 14 }}>
                          <h4>Parameters ({selectedChangeSetDetail.parameters.length})</h4>
                          {selectedChangeSetDetail.parameters.length > 0 ? (
                            <div className="svc-table-area" style={{ border: '1px solid #3b4350', borderRadius: 6, maxHeight: 220 }}>
                              <table className="svc-table">
                                <thead><tr><th>Key</th><th>Value</th><th>Use Previous</th></tr></thead>
                                <tbody>
                                  {selectedChangeSetDetail.parameters.map((parameter) => (
                                    <tr key={parameter.parameterKey}>
                                      <td>{parameter.parameterKey}</td>
                                      <td>{parameter.parameterValue || '-'}</td>
                                      <td>{parameter.usePreviousValue ? 'Yes' : 'No'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          ) : <div className="svc-empty">No parameter overrides were supplied.</div>}
                        </div>

                        <RawJsonBlock title="Raw JSON" json={selectedChangeSetDetail.rawJson} />
                      </>
                    )}
                  </div>
                </>
              )}

              {detailTab === 'drift' && (
                <div className="svc-section">
                  <h3>Drift Detection</h3>
                  <div className="svc-btn-row" style={{ marginBottom: 12 }}>
                    <button className="svc-btn primary" type="button" disabled={driftLoading || driftSummary?.detectionStatus === 'DETECTION_IN_PROGRESS'} onClick={() => void handleStartDriftDetection()}>
                      {driftSummary?.detectionStatus === 'DETECTION_IN_PROGRESS' ? 'Polling Drift Status...' : 'Start Drift Detection'}
                    </button>
                    <button className="svc-btn" type="button" disabled={driftLoading} onClick={() => void handleRefreshDrift()}>Refresh Drift</button>
                  </div>

                  {driftLoading && <div className="svc-section-hint">Refreshing drift state...</div>}
                  {driftSummary ? (
                    <>
                      <div className="svc-kv">
                        <div className="svc-kv-row"><div className="svc-kv-label">Drift Status</div><div className="svc-kv-value"><span className={`svc-badge ${badgeClass(driftSummary.stackDriftStatus)}`}>{driftSummary.stackDriftStatus}</span></div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Detection</div><div className="svc-kv-value"><span className={`svc-badge ${badgeClass(driftSummary.detectionStatus)}`}>{driftSummary.detectionStatus}</span></div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Last Check</div><div className="svc-kv-value">{driftSummary.lastCheckTimestamp ? fmtTs(driftSummary.lastCheckTimestamp) : '-'}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Detection ID</div><div className="svc-kv-value">{driftSummary.driftDetectionId || '-'}</div></div>
                        <div className="svc-kv-row"><div className="svc-kv-label">Notes</div><div className="svc-kv-value">{driftSummary.detectionStatusReason || '-'}</div></div>
                      </div>

                      <div style={{ marginTop: 14 }}>
                        <h4>Drifted Resources ({driftRows.length})</h4>
                        {driftRows.length > 0 ? (
                          <div className="svc-table-area" style={{ border: '1px solid #3b4350', borderRadius: 6, maxHeight: 300 }}>
                            <table className="svc-table">
                              <thead><tr><th>Type</th><th>Logical ID</th><th>Physical ID</th><th>Status</th><th>Details</th></tr></thead>
                              <tbody>
                                {driftRows.map((row) => (
                                  <tr key={`${row.logicalResourceId}-${row.physicalResourceId}`}>
                                    <td>{row.resourceType}</td>
                                    <td>{row.logicalResourceId}</td>
                                    <td>{row.physicalResourceId}</td>
                                    <td><span className={`svc-badge ${badgeClass(row.driftStatus)}`}>{row.driftStatus}</span></td>
                                    <td style={{ whiteSpace: 'normal', maxWidth: 420, verticalAlign: 'top' }}>{row.details}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : <div className="svc-empty">{driftSummary.detectionStatus === 'DETECTION_COMPLETE' ? 'No drifted resources were returned for this stack.' : 'Run drift detection to compare the template against live resources.'}</div>}
                      </div>

                      {driftRows.length > 0 && <RawJsonBlock title="Raw Drift JSON" json={safePretty(driftRows.map((row) => ({ logicalResourceId: row.logicalResourceId, physicalResourceId: row.physicalResourceId, resourceType: row.resourceType, driftStatus: row.driftStatus, propertyDifferences: row.propertyDifferences })))} />}
                    </>
                  ) : <div className="svc-empty">Select a stack to inspect drift state.</div>}
                </div>
              )}
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
                onClick={() => { setSelectedStack(s.stackName); void loadStackDetail(s.stackName) }}
              >{s.stackName}</button>
            ))}
          </div>
          <CfnDiagramView diagram={diagram} />
        </>
      )}
    </div>
  )
}
