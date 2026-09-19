/**
 * React Flow 变更 → GraphProgram 的纯函数桥（评审 P1-2：批量 change 必须以单一基线累积应用）。
 */
import type { moveNode, removeNode } from '../../engine/graphProgram'
import type { GraphProgram } from '../../engine/graphProgram'

type MoveFn = typeof moveNode
type RemoveFn = typeof removeNode

/** RF sourceHandle → 执行边端口（'out'/null → 无端口出边） */
export function portFromHandle(handle: string | null | undefined): 'true' | 'false' | undefined {
  return handle === 'true' || handle === 'false' ? handle : undefined
}

interface MinimalChange {
  type: string
  id: string
  dragging?: boolean
  position?: { x: number; y: number }
}

/**
 * 把一批 RF 节点变更应用于程序。
 * - position 仅在 dragging === false（拖动落点）时写回；拖动中间帧由容器 transient 状态处理
 * - remove 级联删除关联边（removeNode 语义）
 * - 其余 change（dimensions/select/add）由 React Flow 内部维护，宿主忽略
 * 单基线累积：多 change 批次（多选拖动/删除）全部作用于同一递推链。
 */
export function applyNodeChangesToProgram(prog: GraphProgram, changes: MinimalChange[], ops: { moveNode: MoveFn; removeNode: RemoveFn }): GraphProgram {
  let cur = prog
  for (const change of changes) {
    if (change.type === 'position' && change.dragging === false && change.position) {
      cur = ops.moveNode(cur, change.id, change.position.x, change.position.y)
    } else if (change.type === 'remove') {
      cur = ops.removeNode(cur, change.id)
    }
  }
  return cur
}
