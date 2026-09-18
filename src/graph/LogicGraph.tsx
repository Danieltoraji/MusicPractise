/**
 * LogicGraph：LogicProgram 的只读 React Flow 可视化。
 * dagre 自动分层布局（LR）；节点按类别着色；MiniMap/Controls 内置。
 * 默认导出 + 懒加载（编辑器/图谱页按需加载，控制主包体积）。
 */
import { useEffect, useMemo } from 'react'
import dagre from '@dagrejs/dagre'
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { LogicProgram } from '../engine/logic'
import { programToGraph, type GraphNode } from './programToGraph'

const NODE_W = 190
const NODE_H = 52

const KIND_CLASS: Record<GraphNode['kind'], string> = {
  event: 'lg-event',
  rule: 'lg-rule',
  action: 'lg-action',
  var: 'lg-var',
}

function dagreLayout(
  nodes: { id: string; label: string }[],
  edges: { source: string; target: string }[],
): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 90, marginx: 20, marginy: 20 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of nodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  const pos = new Map<string, { x: number; y: number }>()
  for (const n of nodes) {
    const p = g.node(n.id)
    pos.set(n.id, { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 })
  }
  return pos
}

export default function LogicGraph({
  program,
  height = 520,
}: {
  program: LogicProgram
  height?: number
}) {
  return (
    <ReactFlowProvider>
      <LogicGraphInner program={program} height={height} />
    </ReactFlowProvider>
  )
}

function LogicGraphInner({
  program,
  height,
}: {
  program: LogicProgram
  height: number
}) {
  const { fitView } = useReactFlow()
  const graph = useMemo(() => programToGraph(program), [program])

  const rfNodes = useMemo<Node[]>(() => {
    const pos = dagreLayout(
      graph.nodes.map((n) => ({ id: n.id, label: n.label })),
      graph.edges,
    )
    return graph.nodes.map((n) => ({
      id: n.id,
      type: 'default',
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: {
        label: (
          <div className="lg-label">
            <div className="lg-label-main">{n.label}</div>
            {n.sub && <div className="lg-label-sub">{n.sub}</div>}
          </div>
        ),
      },
      className: `lg-node ${KIND_CLASS[n.kind] ?? ''}`,
      style: { width: NODE_W, height: NODE_H },
      draggable: false,
      selectable: true,
    }))
  }, [graph])

  const rfEdges = useMemo<Edge[]>(() => {
    return graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      animated: e.kind === 'trigger',
      style: {
        stroke: e.kind === 'trigger' ? '#d97706' : e.kind === 'write' ? '#16a34a' : '#94a3b8',
        strokeDasharray: e.kind === 'trigger' || e.kind === 'read' ? '5 3' : undefined,
      },
      labelStyle: { fontSize: 11, fill: '#667085' },
      labelBgStyle: { fill: '#f6f7fb' },
    }))
  }, [graph])

  // RF12 的初始 fitView 可能在节点测量完成前执行而失效——节点就绪后再框选一次
  useEffect(() => {
    const t = setTimeout(() => {
      void fitView({ padding: 0.12, duration: 200 })
    }, 150)
    return () => clearTimeout(t)
  }, [fitView, rfNodes])

  return (
    <div className="logic-graph" style={{ height }}>
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        fitView
        minZoom={0.15}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={true}
        proOptions={{ hideAttribution: true }}
      >
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
        <Background gap={16} />
      </ReactFlow>
    </div>
  )
}
