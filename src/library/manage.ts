/**
 * 资源库文件管理器操作（docs/39 批次 H1）：新建/重命名/移动/复制的纯函数层。
 * 全部不可变（structuredClone 后改写），不触碰 Dexie；入库由调用方 putResource。
 * 组织语义：移动执行「单亲」不变量——关卡/专题移动后只被一个容器引用
 * （browse.ts 容许多亲引用，移动操作负责收敛）。内置（builtIn）文档整体只读：
 * 种子每次启动会重放内置记录，任何对内置文档的改写都会被覆盖——移动/复制/新建专题
 * 的目标为内置容器时调用方必须禁用。
 */
import type { LibraryRecord, ResourceKind } from './db'
import { newResourceId } from './id'
import { childIds } from './browse'

/** 容器文档（系列/专题）的最小结构视图：信封字段 + content 引用列表 */
export interface ContainerDoc {
  id: string
  kind: ResourceKind
  version: string
  meta: Record<string, unknown>
  content: Record<string, unknown>
  [key: string]: unknown
}

export interface SeriesDoc extends ContainerDoc {
  kind: 'series'
  content: { topicIds: string[] } & Record<string, unknown>
}

export interface TopicDoc extends ContainerDoc {
  kind: 'topic'
  content: { levelIds: string[]; brief?: string } & Record<string, unknown>
}

/** 关卡文档的宽松视图（库内允许 v1/v2 旧格式，复制不迁移格式） */
export interface LevelLike {
  id: string
  kind: 'level'
  version: string
  meta: Record<string, unknown>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// 文档工厂
// ---------------------------------------------------------------------------

function blankMeta(title: string): Record<string, unknown> {
  return {
    title,
    description: '',
    author: { name: '' },
    tags: [],
    locale: 'zh-CN',
    license: 'CC0-1.0',
    difficulty: 1,
  }
}

export function blankSeriesDoc(title = '未命名系列'): SeriesDoc {
  return {
    schemaVersion: 1,
    kind: 'series',
    id: newResourceId(),
    version: '0.1.0',
    meta: blankMeta(title),
    refs: [],
    content: { topicIds: [] },
  }
}

export function blankTopicDoc(title = '未命名专题'): TopicDoc {
  return {
    schemaVersion: 1,
    kind: 'topic',
    id: newResourceId(),
    version: '0.1.0',
    meta: blankMeta(title),
    refs: [],
    content: { levelIds: [], brief: '' },
  }
}

// ---------------------------------------------------------------------------
// 重命名与引用列表
// ---------------------------------------------------------------------------

/** 重命名（改 meta.title）：NFC + trim；空标题原样返回（调用方应先校验非空） */
export function renameDoc<T extends { meta: Record<string, unknown> }>(doc: T, title: string): T {
  const cleaned = title.normalize('NFC').trim()
  if (cleaned === '') return doc
  const next = structuredClone(doc)
  next.meta = { ...next.meta, title: cleaned }
  return next
}

function withRefList<T extends ContainerDoc>(doc: T, key: 'topicIds' | 'levelIds', ids: string[]): T {
  const next = structuredClone(doc)
  next.content = { ...next.content, [key]: ids }
  return next
}

/** 追加引用 id（已存在则原样返回，不产生新对象） */
export function appendRefId<T extends ContainerDoc>(doc: T, key: 'topicIds' | 'levelIds', id: string): T {
  const ids = childIds(doc, key)
  if (ids.includes(id)) return doc
  return withRefList(doc, key, [...ids, id])
}

// ---------------------------------------------------------------------------
// 移动（单亲不变量：只克隆被触及的容器，未触及的保持原引用）
// ---------------------------------------------------------------------------

/** 关卡移动到目标专题（null = 移出全部专题，回落未整理） */
export function moveLevelIntoTopic(levelId: string, targetTopicId: string | null, topics: ContainerDoc[]): ContainerDoc[] {
  return topics.map((t) => {
    const ids = childIds(t, 'levelIds')
    const has = ids.includes(levelId)
    if (t.id === targetTopicId) {
      return has ? t : withRefList(t, 'levelIds', [...ids, levelId])
    }
    return has ? withRefList(t, 'levelIds', ids.filter((x) => x !== levelId)) : t
  })
}

/** 专题移动到目标系列（null = 移出全部系列，回落未整理） */
export function moveTopicIntoSeries(topicId: string, targetSeriesId: string | null, series: ContainerDoc[]): ContainerDoc[] {
  return series.map((s) => {
    const ids = childIds(s, 'topicIds')
    const has = ids.includes(topicId)
    if (s.id === targetSeriesId) {
      return has ? s : withRefList(s, 'topicIds', [...ids, topicId])
    }
    return has ? withRefList(s, 'topicIds', ids.filter((x) => x !== topicId)) : s
  })
}

// ---------------------------------------------------------------------------
// 复制
// ---------------------------------------------------------------------------

const COPY_SUFFIX = '（副本）'

function withCopySuffix(title: unknown): string {
  const t = typeof title === 'string' ? title : ''
  return t.includes(COPY_SUFFIX) ? t : `${t}${COPY_SUFFIX}`
}

/** 复制单个关卡文档：新 id、标题加「（副本）」（已有后缀不重复），内容原样深拷贝不迁移格式 */
export function copyLevelDoc<T extends LevelLike>(doc: T): T {
  const copy = structuredClone(doc)
  copy.id = newResourceId()
  copy.meta = { ...copy.meta, title: withCopySuffix(copy.meta.title) }
  return copy
}

/**
 * 整树复制系列：系列/专题/被引用关卡全部换新 id 并重写引用。
 * 共享关卡只复制一份（多专题引用同一旧关卡 → 引用同一新副本）；
 * 库内缺件（levels 中找不到）的引用 id 原样保留；仅系列根标题加「（副本）」。
 */
export function copySeriesTree(
  series: SeriesDoc,
  topics: TopicDoc[],
  levels: LevelLike[],
): { series: SeriesDoc; topics: TopicDoc[]; levels: LevelLike[] } {
  const referenced = new Set<string>()
  for (const t of topics) {
    for (const id of childIds(t, 'levelIds')) referenced.add(id)
  }
  const levelMap = new Map<string, LevelLike>()
  const newLevels: LevelLike[] = []
  for (const id of referenced) {
    const src = levels.find((l) => l.id === id)
    if (src === undefined) continue
    const copy = structuredClone(src)
    copy.id = newResourceId()
    levelMap.set(id, copy)
    newLevels.push(copy)
  }
  const topicMap = new Map<string, TopicDoc>()
  const newTopics: TopicDoc[] = []
  for (const t of topics) {
    const copy = structuredClone(t)
    copy.id = newResourceId()
    copy.content = {
      ...copy.content,
      levelIds: childIds(t, 'levelIds').map((id) => levelMap.get(id)?.id ?? id),
    }
    topicMap.set(t.id, copy)
    newTopics.push(copy)
  }
  const newSeries = structuredClone(series)
  newSeries.id = newResourceId()
  newSeries.meta = { ...newSeries.meta, title: withCopySuffix(newSeries.meta.title) }
  newSeries.content = {
    ...newSeries.content,
    topicIds: childIds(series, 'topicIds').map((id) => topicMap.get(id)?.id ?? id),
  }
  return { series: newSeries, topics: newTopics, levels: newLevels }
}

// ---------------------------------------------------------------------------
// 云盘文件夹上传（docs/39 H2）：收集系列闭包文档
// ---------------------------------------------------------------------------

export interface BundleDoc {
  id: string
  kind: 'series' | 'topic' | 'level'
  doc: unknown
}

/**
 * 收集系列上传所需的闭包文档（系列 + 专题 + 被引关卡，共享关卡去重）。
 * 缺件抛可读错误（调用方直接展示）；levelCount = 内含关卡数 = 槽位占用。
 */
export function collectSeriesDocs(seriesRec: LibraryRecord, all: LibraryRecord[]): { docs: BundleDoc[]; levelCount: number } {
  if (seriesRec.kind !== 'series') throw new Error('不是系列文档')
  const byId = new Map(all.map((r) => [r.id, r]))
  const docs: BundleDoc[] = [{ id: seriesRec.id, kind: 'series', doc: seriesRec.doc }]
  const seen = new Set<string>([seriesRec.id])
  let levelCount = 0
  for (const tid of childIds(seriesRec.doc, 'topicIds')) {
    const t = byId.get(tid)
    if (t === undefined || t.kind !== 'topic') throw new Error(`系列缺件：专题 ${tid} 不在本机库中，无法上传`)
    if (!seen.has(tid)) {
      seen.add(tid)
      docs.push({ id: tid, kind: 'topic', doc: t.doc })
    }
    for (const lid of childIds(t.doc, 'levelIds')) {
      const l = byId.get(lid)
      if (l === undefined || l.kind !== 'level') throw new Error(`专题缺件：关卡 ${lid} 不在本机库中，无法上传`)
      if (!seen.has(lid)) {
        seen.add(lid)
        docs.push({ id: lid, kind: 'level', doc: l.doc })
        levelCount++
      }
    }
  }
  return { docs, levelCount }
}

/**
 * 从已解析的 JSON 文档集合中收集系列 bundle（官方直传/群组上传共用）：
 * 找到 kind=series 的文档，按 topicIds/levelIds 闭包收集，缺件抛可读错误。
 */
export function bundleFromParsedDocs(docs: Record<string, unknown>[]): { folderId: string; title: string; docs: { id: string; kind: string; payload: unknown }[] } {
  const series = docs.find((d) => d.kind === 'series') as { id?: unknown; meta?: { title?: unknown }; content?: { topicIds?: unknown } } | undefined
  if (!series || typeof series.id !== 'string') throw new Error('所选文件中没有系列文档（kind=series）')
  const byId = new Map(docs.filter((d) => typeof d.id === 'string').map((d) => [String(d.id), d]))
  const bundle: { id: string; kind: string; payload: unknown }[] = [{ id: series.id, kind: 'series', payload: series }]
  const seen = new Set<string>([series.id])
  const topicIds = Array.isArray(series.content?.topicIds) ? (series.content?.topicIds as string[]) : []
  for (const tid of topicIds) {
    const t = byId.get(tid) as { content?: { levelIds?: unknown } } | undefined
    if (!t) throw new Error(`缺件：专题 ${tid} 不在所选文件中`)
    if (!seen.has(tid)) {
      seen.add(tid)
      bundle.push({ id: tid, kind: 'topic', payload: t })
    }
    const levelIds = Array.isArray(t.content?.levelIds) ? (t.content?.levelIds as string[]) : []
    for (const lid of levelIds) {
      const l = byId.get(lid)
      if (!l) throw new Error(`缺件：关卡 ${lid} 不在所选文件中`)
      if (!seen.has(lid)) {
        seen.add(lid)
        bundle.push({ id: lid, kind: 'level', payload: l })
      }
    }
  }
  const title = typeof series.meta?.title === 'string' ? series.meta.title : series.id
  return { folderId: series.id, title, docs: bundle }
}
