/**
 * v4 图工作台布局：dagre 分层（LR）自动定位。
 *
 * 用途：
 * - 编辑器新增节点时给一个不与现有节点重叠的落点；
 * - 「整理布局」按钮全图重排（写回节点 x/y，IR 持久化）；
 * - 无坐标节点（JSON 手写/AI 写入）首帧兜底定位（不写回 IR，等作者拖动/整理）。
 *
 * 与 v3 `editor/graph/layout.ts` 同构（节点尺寸/间距口径一致，视觉连续）。
 */
import dagre from '@dagrejs/dagre'
import type { BehaviorProgram, FlowProgram, GraphEdge } from '../../../engine/v4/model'

export const NODE_W = 244
export const NODE_H = 84

export interface GraphLayoutProgram {
  nodes: { id: string; x?: number; y?: number }[]
  edges: GraphEdge[]
}

/** 计算全图 dagre 位置表（不读节点现有坐标） */
export function dagrePositions(program: GraphLayoutProgram): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph()
  graph.setGraph({ rankdir: 'LR', nodesep: 44, ranksep: 112, marginx: 28, marginy: 28 })
  graph.setDefaultEdgeLabel(() => ({}))
  for (const node of program.nodes) graph.setNode(node.id, { width: NODE_W, height: NODE_H })
  for (const edge of program.edges) {
    // dagre 不接受重复边（同 from+to 的真/假双出边会叠）——去重即可，位置计算不需要双边
    if (graph.hasEdge(edge.from, edge.to)) continue
    if (!graph.hasNode(edge.from) || !graph.hasNode(edge.to)) continue
    graph.setEdge(edge.from, edge.to)
  }
  dagre.layout(graph)
  const out = new Map<string, { x: number; y: number }>()
  for (const node of program.nodes) {
    const laid = graph.node(node.id) as { x: number; y: number } | undefined
    if (laid) out.set(node.id, { x: Math.round(laid.x - NODE_W / 2), y: Math.round(laid.y - NODE_H / 2) })
  }
  return out
}

/** 缺坐标节点的兜底定位表；所有节点都有坐标时返回空表（避免无谓计算） */
export function missingPositions(program: GraphLayoutProgram): Map<string, { x: number; y: number }> {
  if (!program.nodes.some((node) => node.x === undefined || node.y === undefined)) return new Map()
  return dagrePositions(program)
}

/** 新节点落点：画布中部偏左的网格位（不与已有节点堆叠；真实像素由 React Flow 画布消费） */
export function nextNodePosition(program: { nodes: { id: string }[] }): { x: number; y: number } {
  return { x: 60 + (program.nodes.length % 4) * 280, y: 60 + Math.floor(program.nodes.length / 4) * 140 }
}

export type ArrangeMode = 'missing' | 'all'

/**
 * 重排布局（返回新 program；IR 结构共享，只改节点 x/y）：
 * - 'missing'：只给没有 x/y 的节点补位置；
 * - 'all'：全图重排（「整理布局」）。
 */
export function arrangePositions<P extends FlowProgram | BehaviorProgram>(program: P, mode: ArrangeMode): P {
  const positions = dagrePositions(program)
  let changed = false
  const nodes = program.nodes.map((node) => {
    if (mode === 'missing' && node.x !== undefined && node.y !== undefined) return node
    const pos = positions.get(node.id)
    if (!pos) return node
    if (node.x === pos.x && node.y === pos.y) return node
    changed = true
    return { ...node, x: pos.x, y: pos.y }
  })
  if (!changed) return program
  return { ...program, nodes } as P
}
