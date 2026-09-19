/**
 * 模板落图纯函数：批量分配 id（newNodeId 递推）、索引→id 边映射、逐节点 addNode/connect。
 * 单测覆盖「落图后 lint 零错」。
 */
import {
  addNode,
  connect,
  newNodeId,
  type GraphProgram,
  type GNode,
} from '../../engine/graphProgram'
import type { PaletteTemplate } from './palette'

export function applyTemplate(prog: GraphProgram, tpl: PaletteTemplate, pos?: { x: number; y: number }): GraphProgram {
  const made = tpl.make(pos)
  let cur = prog
  const idByIndex: string[] = []
  made.nodes.forEach((shape) => {
    const id = newNodeId(cur)
    idByIndex.push(id)
    cur = addNode(cur, { ...shape, id } as GNode)
  })
  for (const link of made.links) {
    const from = idByIndex[link.from]
    const to = idByIndex[link.to]
    if (!from || !to) throw new Error(`模板 ${tpl.key} 的连线引用越界（${link.from} → ${link.to}）`)
    cur = connect(cur, from, to, link.port)
  }
  return cur
}
