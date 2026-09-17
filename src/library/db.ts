/**
 * 资源库：IndexedDB（Dexie）中的文档库，简化单态——入库即可玩，无草稿/发布。
 * 内置示例关卡首次启动时 seed（builtIn 标记，UI 禁删），此后应用只从库读内容。
 */
import Dexie, { type EntityTable } from 'dexie'
import noteClickDoc from '../sample/note-click.level.json'
import theoryChoiceDoc from '../sample/theory-choice.level.json'
import melodyDictationDoc from '../sample/melody-dictation.level.json'
import timedReactionDoc from '../sample/timed-reaction.level.json'
import noteSpellingDoc from '../sample/note-spelling.level.json'
import clefTestDoc from '../sample/clef-test.level.json'
import starterSeries from '../sample/starter.series.json'
import starterTopic1 from '../sample/starter-topic1.topic.json'
import starterTopic2 from '../sample/starter-topic2.topic.json'

export type ResourceKind = 'series' | 'topic' | 'level' | 'instrument'

export interface LibraryRecord {
  id: string
  kind: ResourceKind
  version: string
  /** meta.title 冗余，列表展示用 */
  title: string
  doc: unknown
  importedAt: number
  builtIn: 0 | 1
}

/** 练习进度存档：运行时数据（非内容文档），每关一条 */
export interface ProgressRecord {
  levelId: string
  bestScore: number
  passed: 0 | 1
  attempts: number
  updatedAt: number
}

export const db = new Dexie('music-practise-library') as Dexie & {
  resources: EntityTable<LibraryRecord, 'id'>
  progress: EntityTable<ProgressRecord, 'levelId'>
}

db.version(1).stores({
  resources: 'id, kind, version, importedAt, builtIn',
})
db.version(2).stores({
  resources: 'id, kind, version, importedAt, builtIn',
  progress: 'levelId',
})

const LEVEL_DOCS = [
  noteClickDoc,
  theoryChoiceDoc,
  melodyDictationDoc,
  timedReactionDoc,
  noteSpellingDoc,
  clefTestDoc,
] as unknown as Parameters<typeof toRecord>[0][]

const STARTER_DOCS = [
  starterSeries,
  starterTopic1,
  starterTopic2,
] as unknown as Parameters<typeof toRecord>[0][]

function toRecord(doc: {
  id: string
  kind: ResourceKind
  version: string
  meta: { title?: unknown }
}, builtIn: boolean): LibraryRecord {
  return {
    id: doc.id,
    kind: doc.kind,
    version: doc.version,
    title: typeof doc.meta?.title === 'string' ? doc.meta.title : doc.id,
    doc,
    importedAt: Date.now(),
    builtIn: builtIn ? 1 : 0,
  }
}

/**
 * 内置示例入库（5 关卡 + 入门系列 1 系列 2 专题）。
 * 只补"缺失或仍为内置"的记录：用户导入的同 id 文档（builtIn=0，可能异版本）
 * 不会被应用内置版本静默覆盖。
 */
export async function ensureSeeded(): Promise<void> {
  const builtIns = [...LEVEL_DOCS, ...STARTER_DOCS].map((doc) => toRecord(doc, true))
  const existing = await db.resources.bulkGet(builtIns.map((r) => r.id))
  const toPut: LibraryRecord[] = []
  builtIns.forEach((record, i) => {
    const ex = existing[i]
    if (!ex || ex.builtIn === 1) toPut.push(record)
  })
  if (toPut.length > 0) await db.resources.bulkPut(toPut)
}

export async function listResources(kind?: ResourceKind): Promise<LibraryRecord[]> {
  if (kind) return db.resources.where('kind').equals(kind).toArray()
  return db.resources.orderBy('importedAt').toArray()
}

export async function getResource(id: string): Promise<LibraryRecord | undefined> {
  return db.resources.get(id)
}

/** 入库/更新一条文档（从信封自动取 id/kind/version/title） */
export async function putResource(
  doc: { id: string; kind: ResourceKind; version: string; meta: { title?: unknown } },
  builtIn = false,
): Promise<void> {
  await db.resources.put(toRecord(doc, builtIn))
}

export async function deleteResource(id: string): Promise<void> {
  const record = await db.resources.get(id)
  if (!record) return
  if (record.builtIn) throw new Error('内置示例不可删除')
  await db.resources.delete(id)
}

// ---------------------------------------------------------------------------
// 练习进度存档
// ---------------------------------------------------------------------------

export async function saveProgress(
  levelId: string,
  result: { score: number; passed: boolean },
): Promise<ProgressRecord> {
  return db.transaction('rw', db.progress, async () => {
    const prev = await db.progress.get(levelId)
    const next: ProgressRecord = {
      levelId,
      bestScore: Math.max(prev?.bestScore ?? 0, result.score),
      passed: (prev?.passed === 1 || result.passed) ? 1 : 0,
      attempts: (prev?.attempts ?? 0) + 1,
      updatedAt: Date.now(),
    }
    await db.progress.put(next)
    return next
  })
}

export async function getProgress(levelId: string): Promise<ProgressRecord | undefined> {
  return db.progress.get(levelId)
}

export async function listProgress(): Promise<ProgressRecord[]> {
  return db.progress.toArray()
}
