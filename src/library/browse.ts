/**
 * 浏览组织：把库中的关卡按「被专题引用」与「独立」分区，以及资源库文件夹树。
 */
import type { LibraryRecord } from './db'
import { migrateDocToV3 } from '../engine/migrateDoc'

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

/**
 * 取有序子行：缺失 id 跳过、重复 id 去重（评审 P2-3）。
 * 深度上限 = 树语义层数（系列0→专题1→关卡2），更深即循环引用毒数据，截断而非栈溢出（评审 P1-1）。
 */
function childRecords(all: Map<string, LibraryRecord>, ids: string[], depth = 0): LibraryTreeRow[] {
  if (depth > 2) return []
  const seen = new Set<string>()
  const out: LibraryTreeRow[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const rec = all.get(id)
    if (rec === undefined) continue
    out.push({
      rec,
      children: rec.kind === 'topic' ? childRecords(all, childIds(rec.doc, 'levelIds'), depth + 1) : undefined,
    })
  }
  return out
}

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

/**
 * 读取库记录的关卡文档并迁移到 v3（页面列表直接读原始库记录，可能还是 v1/v2 旧格式）。
 * 迁移失败的毒数据返回 null，调用方降级渲染——绝不让列表页白屏（docs/23 评审 P1-1 同源教训）。
 */
export function readLevelDoc(rec: LibraryRecord): import('../engine/level').LevelDoc | null {
  try {
    return migrateDocToV3(rec.doc)
  } catch {
    return null
  }
}
