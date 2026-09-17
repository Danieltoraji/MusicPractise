/**
 * 资源库：IndexedDB（Dexie）中的文档库，简化单态——入库即可玩，无草稿/发布。
 * 内置示例关卡首次启动时 seed（builtIn 标记，UI 禁删），此后应用只从库读内容。
 */
import Dexie, { type EntityTable } from 'dexie'
import type { LevelDoc } from '../engine/level'
import noteClickDoc from '../sample/note-click.level.json'
import theoryChoiceDoc from '../sample/theory-choice.level.json'
import melodyDictationDoc from '../sample/melody-dictation.level.json'
import timedReactionDoc from '../sample/timed-reaction.level.json'
import noteSpellingDoc from '../sample/note-spelling.level.json'

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

export const db = new Dexie('music-practise-library') as Dexie & {
  resources: EntityTable<LibraryRecord, 'id'>
}

db.version(1).stores({
  resources: 'id, kind, version, importedAt, builtIn',
})

const LEVEL_DOCS = [
  noteClickDoc,
  theoryChoiceDoc,
  melodyDictationDoc,
  timedReactionDoc,
  noteSpellingDoc,
] as unknown as LevelDoc[]

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

/** 首次启动（库为空）时把内置示例关卡入库；bulkPut 幂等，可安全重复调用 */
export async function ensureSeeded(): Promise<void> {
  const count = await db.resources.count()
  if (count > 0) return
  const records = LEVEL_DOCS.map((doc) => toRecord(doc as unknown as Parameters<typeof toRecord>[0], true))
  await db.resources.bulkPut(records)
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
