// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db, deleteResource, ensureSeeded, getResource, listResources, putResource } from './db'

beforeEach(async () => {
  await db.resources.clear()
  await ensureSeeded()
})

describe('资源库（Dexie，简化单态）', () => {
  it('ensureSeeded 首次启动把 5 个内置关卡入库', async () => {
    const levels = await listResources('level')
    expect(levels).toHaveLength(5)
    expect(levels.every((r) => r.builtIn === 1)).toBe(true)
    expect(levels.map((r) => r.title)).toContain('听音点击 · 入门')
  })

  it('ensureSeeded 幂等：重复调用不产生重复记录', async () => {
    await ensureSeeded()
    await ensureSeeded()
    expect(await db.resources.count()).toBe(5)
  })

  it('listResources 按 kind 过滤', async () => {
    expect(await listResources('series')).toHaveLength(0)
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
    expect(await db.resources.count()).toBe(5)
  })

  it('deleteResource 拒绝删除内置文档，普通文档可删', async () => {
    const seeded = (await listResources('level'))[0]
    await expect(deleteResource(seeded.id)).rejects.toThrow(/内置/)
    const temp = {
      schemaVersion: 1,
      kind: 'level' as const,
      id: 'res_01J9C0C0C0C0C0C0C0C0C0C0C1',
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
