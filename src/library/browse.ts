/**
 * 浏览组织：把库中的关卡按「被专题引用」与「独立」分区。
 */
import type { LibraryRecord } from './db'

/** 被任何专题引用过的关卡 id 集合 */
export function organizedLevelIds(topics: LibraryRecord[]): Set<string> {
  const out = new Set<string>()
  for (const t of topics) {
    const ids = (t.doc as { content?: { levelIds?: unknown } }).content?.levelIds
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'string') out.add(id)
      }
    }
  }
  return out
}

export function partitionLevels(
  levels: LibraryRecord[],
  topics: LibraryRecord[],
): { organized: LibraryRecord[]; independent: LibraryRecord[] } {
  const ids = organizedLevelIds(topics)
  const organized: LibraryRecord[] = []
  const independent: LibraryRecord[] = []
  for (const l of levels) (ids.has(l.id) ? organized : independent).push(l)
  return { organized, independent }
}

/** 从专题/系列文档里取有序的子级 id 列表 */
export function childIds(doc: unknown, key: 'topicIds' | 'levelIds'): string[] {
  const ids = (doc as { content?: Record<string, unknown> }).content?.[key]
  return Array.isArray(ids) ? ids.filter((v): v is string => typeof v === 'string') : []
}
