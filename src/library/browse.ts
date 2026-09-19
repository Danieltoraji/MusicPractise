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

// ---------------------------------------------------------------------------
// 资源库树（系列=文件夹 → 专题=子文件夹 → 关卡=文件）
// ---------------------------------------------------------------------------

export interface LibraryTreeRow {
  rec: LibraryRecord
  /** 子行（系列=专题列表；专题=关卡列表；关卡/乐器无子行） */
  children?: LibraryTreeRow[]
}

const childRecords = (all: Map<string, LibraryRecord>, ids: string[]): LibraryTreeRow[] =>
  ids
    .map((id) => all.get(id))
    .filter((r): r is LibraryRecord => r !== undefined)
    .map((rec) => ({
      rec,
      children: rec.kind === 'topic' ? childRecords(all, childIds(rec.doc, 'levelIds')) : undefined,
    }))

/**
 * 把平铺的资源记录组织成树：系列（引用的专题）→ 专题（引用的关卡）。
 * 引用缺失的子 id 直接跳过；未被任何容器引用的资源进入 loose（未整理）区。
 */
export function buildLibraryTree(resources: LibraryRecord[]): {
  series: LibraryTreeRow[]
  loose: LibraryTreeRow[]
} {
  const all = new Map(resources.map((r) => [r.id, r]))
  const inSeries = new Set<string>()
  const inTopic = new Set<string>()
  const seriesRows: LibraryTreeRow[] = []
  for (const rec of resources) {
    if (rec.kind !== 'series') continue
    const topics = childRecords(all, childIds(rec.doc, 'topicIds'))
    for (const t of topics) {
      inSeries.add(t.rec.id)
      // 系列内专题的关卡同样视为已整理（避免重复出现在未整理区）
      for (const l of childRecords(all, childIds(t.rec.doc, 'levelIds'))) inTopic.add(l.rec.id)
    }
    seriesRows.push({ rec, children: topics })
  }
  const loose: LibraryTreeRow[] = []
  for (const rec of resources) {
    if (rec.kind === 'series') continue
    if (rec.kind === 'topic') {
      if (inSeries.has(rec.id)) continue
      loose.push({ rec, children: childRecords(all, childIds(rec.doc, 'levelIds')) })
      for (const l of childRecords(all, childIds(rec.doc, 'levelIds'))) inTopic.add(l.rec.id)
      continue
    }
    if (rec.kind === 'level' && inTopic.has(rec.id)) continue
    loose.push({ rec, children: undefined })
  }
  return { series: seriesRows, loose }
}

/** 按标题关键词过滤：命中文件夹名 → 整棵子树保留；命中叶子 → 保留祖先路径；空关键词原样返回 */
export function filterTree(rows: LibraryTreeRow[], query: string): LibraryTreeRow[] {
  const kw = query.trim().toLowerCase()
  if (kw === '') return rows
  const walk = (rows: LibraryTreeRow[]): LibraryTreeRow[] => {
    const out: LibraryTreeRow[] = []
    for (const r of rows) {
      if (r.rec.title.toLowerCase().includes(kw)) {
        out.push(r)
        continue
      }
      if (r.children) {
        const children = walk(r.children)
        if (children.length > 0) out.push({ ...r, children })
      }
    }
    return out
  }
  return walk(rows)
}
