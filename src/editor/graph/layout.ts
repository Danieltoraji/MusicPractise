/**
 * dagre 自动分层布局（LR）：迁移产物等无位置节点首次打开的兜底定位，
 * 以及工具条「整理布局」的全图重排。位置写入 GNode.x/y（IR 持久化）。
 */
import dagre from '@dagrejs/dagre'
import type { GraphProgram } from '../../engine/graphProgram'

export const NODE_W = 244
export const NODE_H = 84

/** 计算全图 dagre 位置表 */
export function dagrePositions(prog: GraphProgram): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 44, ranksep: 112, marginx: 28, marginy: 28 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const node of prog.nodes) g.setNode(node.id, { width: NODE_W, height: NODE_H })
  for (const e of prog.edges) {
    // dagre 不接受重复边（同 from+to 的真/假双出边会叠）——去重即可，位置计算不需要双边
    if (g.hasEdge(e.from, e.to)) continue
    g.setEdge(e.from, e.to)
  }
  dagre.layout(g)
  const out = new Map<string, { x: number; y: number }>()
  for (const node of prog.nodes) {
    const n = g.node(node.id)
    if (n) out.set(node.id, { x: n.x - NODE_W / 2, y: n.y - NODE_H / 2 })
  }
  return out
}

/**
 * 重排布局。mode:
 * - 'missing'：只给没有 x/y 的节点补位置（迁移产物首次打开）
 * - 'all'：全图重排（「整理布局」按钮）
 */
export function arrangeLayout(prog: GraphProgram, mode: 'missing' | 'all'): GraphProgram {
  const pos = dagrePositions(prog)
  const next = structuredClone(prog)
  for (const node of next.nodes) {
    if (mode === 'missing' && node.x !== undefined && node.y !== undefined) continue
    const p = pos.get(node.id)
    if (p) {
      node.x = Math.round(p.x)
      node.y = Math.round(p.y)
    }
  }
  return next
}
