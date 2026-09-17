/**
 * refs 闭包：series→topicIds→levels 逐层收集 + 各文档 refs[] 弱引用。
 * 用于导入（缺件拒绝）与导出（按闭包打包）。
 */
import type { ResourceKind } from './db'

export interface ResourceLite {
  id: string
  kind: ResourceKind
  doc: Record<string, unknown>
}

export interface ClosureResult {
  /** 闭包内全部文档 id */
  complete: Set<string>
  /** 被引用但在池中缺失的文档 */
  missing: { id: string; neededBy: string }[]
}

function referencedIds(doc: Record<string, unknown>): { id: string; neededBy: string }[] {
  const content = doc.content as Record<string, unknown> | undefined
  const out: { id: string; neededBy: string }[] = []
  for (const ref of (doc.refs as { id?: unknown }[] | undefined) ?? []) {
    if (typeof ref?.id === 'string') out.push({ id: ref.id, neededBy: String(doc.id) })
  }
  if (Array.isArray(content?.topicIds)) {
    for (const id of content.topicIds) {
      if (typeof id === 'string') out.push({ id, neededBy: String(doc.id) })
    }
  }
  if (Array.isArray(content?.levelIds)) {
    for (const id of content.levelIds) {
      if (typeof id === 'string') out.push({ id, neededBy: String(doc.id) })
    }
  }
  return out
}

/**
 * 在文档池内做引用闭包分析：从 rootIds 出发，可跳入池中任何文档
 * （导入时池=包内+本机库、根=包内文档；导出时池=全库、根=所选文档）。
 */
export function resolveClosure(pool: ResourceLite[], rootIds: string[]): ClosureResult {
  const byId = new Map(pool.map((d) => [d.id, d]))
  const complete = new Set<string>()
  const missing: { id: string; neededBy: string }[] = []
  const missingSeen = new Set<string>()

  const visit = (id: string, neededBy: string): void => {
    if (complete.has(id)) return
    const lite = byId.get(id)
    if (!lite) {
      const key = `${id}<-${neededBy}`
      if (!missingSeen.has(key)) {
        missingSeen.add(key)
        missing.push({ id, neededBy })
      }
      return
    }
    complete.add(id)
    for (const ref of referencedIds(lite.doc)) visit(ref.id, ref.neededBy)
  }

  for (const id of rootIds) visit(id, '(root)')
  return { complete, missing }
}
