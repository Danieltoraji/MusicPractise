// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, deleteResource, ensureSeeded, getProgress, getResource, listProgress, listResources, putResource, saveProgress } from './db'

beforeEach(async () => {
  await db.resources.clear()
  await db.progress.clear()
  await ensureSeeded()
})

describe('资源库（Dexie，简化单态）', () => {
  it('ensureSeeded 把内置内容入库：5 关卡 + 入门系列 1 系列 2 专题', async () => {
    const levels = await listResources('level')
    expect(levels).toHaveLength(5)
    expect(levels.every((r) => r.builtIn === 1)).toBe(true)
    expect(levels.map((r) => r.title)).toContain('听音点击 · 入门')
    expect(await listResources('series')).toHaveLength(1)
    expect(await listResources('topic')).toHaveLength(2)
    expect(await db.resources.count()).toBe(8)
  })

  it('ensureSeeded 幂等：重复调用不产生重复记录', async () => {
    await ensureSeeded()
    await ensureSeeded()
    expect(await db.resources.count()).toBe(8)
  })

  it('listResources 按 kind 过滤', async () => {
    expect(await listResources('series')).toHaveLength(1)
    expect(await listResources('level')).toHaveLength(5)
  })

  it('putResource 新增与按信封取字段', async () => {
    const doc = {
      schemaVersion: 1,
      kind: 'instrument' as const,
      id: 'res_01J9B0B0B0B0B0B0B0B0B0B0B9',
      version: '1.0.0',
      meta: { title: '测试乐器' },
      refs: [],
      content: { type: 'keyboard', keyCount: 25, noteMap: { '60': [{ key: 12 }] } },
    }
    await putResource(doc)
    const rec = await getResource(doc.id)
    expect(rec).toMatchObject({ kind: 'instrument', version: '1.0.0', title: '测试乐器', builtIn: 0 })
  })

  it('同 id 同 version 覆盖写入（幂等）', async () => {
    const doc = {
      schemaVersion: 1,
      kind: 'level' as const,
      id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A1',
      version: '1.0.0',
      meta: { title: '听音点击 · 入门' },
      refs: [],
      content: (await getResource('res_01J9A0A0A0A0A0A0A0A0A0A0A1'))!.doc,
    }
    await putResource(doc)
    expect(await db.resources.count()).toBe(8)
  })

  it('deleteResource 拒绝删除内置文档，普通文档可删', async () => {
    const seeded = (await listResources('level'))[0]
    await expect(deleteResource(seeded.id)).rejects.toThrow(/内置/)
    const temp = {
      schemaVersion: 1,
      kind: 'level' as const,
      id: 'res_01J9C0C0C0C0C0C0C0C0C0C0C0',
      version: '1.0.0',
      meta: { title: '临时关卡' },
      refs: [],
      content: seeded.doc,
    }
    await putResource(temp)
    await deleteResource(temp.id)
    expect(await getResource(temp.id)).toBeUndefined()
  })
})

describe('练习进度存档', () => {
  it('saveProgress 首次记录：最高分/通过/次数', async () => {
    await saveProgress('level-A', { score: 20, passed: true })
    const p = await getProgress('level-A')
    expect(p).toMatchObject({ levelId: 'level-A', bestScore: 20, passed: 1, attempts: 1 })
  })

  it('再次完成取更高分；通过状态一旦达成保持', async () => {
    await saveProgress('level-A', { score: 30, passed: true })
    await saveProgress('level-A', { score: 10, passed: false })
    const p = await getProgress('level-A')
    expect(p).toMatchObject({ bestScore: 30, passed: 1, attempts: 2 })
  })

  it('未通过不影响其他关卡的进度', async () => {
    await saveProgress('level-A', { score: 10, passed: false })
    await saveProgress('level-B', { score: 20, passed: true })
    expect((await getProgress('level-A'))!.passed).toBe(0)
    expect((await getProgress('level-B'))!.passed).toBe(1)
    expect(await listProgress()).toHaveLength(2)
  })
})
