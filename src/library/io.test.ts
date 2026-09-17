// @vitest-environment node
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import melodyDictationDoc from '../sample/melody-dictation.level.json'
import noteClickDoc from '../sample/note-click.level.json'
import starterSeries from '../sample/starter.series.json'
import starterTopic1 from '../sample/starter-topic1.topic.json'
import starterTopic2 from '../sample/starter-topic2.topic.json'
import { db, ensureSeeded } from './db'
import { exportResource, importDocuments, importFromFiles, packBundle, unpackBundle } from './io'
import { strToU8, unzipSync, zipSync } from 'fflate'

beforeEach(async () => {
  await db.resources.clear()
  await ensureSeeded() // 5 个内置关卡入库
})

describe('打包 / 解包', () => {
  it('packBundle → unpackBundle 往返无损', () => {
    const docs = [noteClickDoc, starterSeries] as unknown as Record<string, unknown>[]
    const bytes = packBundle(docs)
    const { entries, parseErrors } = unpackBundle(bytes)
    expect(parseErrors).toEqual([])
    expect(entries).toHaveLength(2)
    const restored = entries.map((e) => e.doc)
    expect(restored).toContainEqual(noteClickDoc)
    expect(restored).toContainEqual(starterSeries)
  })

  it('空包与非 JSON 条目', () => {
    expect(() => unpackBundle(packBundle([]))).toThrow(/没有 resources/)
    // 一个合法条目 + 一个坏条目：好的照常解析，坏的进 parseErrors
    const bytes = packBundle([noteClickDoc as unknown as Record<string, unknown>])
    const unzipped = unzipSync(bytes)
    unzipped['resources/broken.json'] = strToU8('{ not json')
    const rebuilt = zipSync(unzipped)
    const { entries, parseErrors } = unpackBundle(rebuilt)
    expect(entries).toHaveLength(1)
    expect(parseErrors).toHaveLength(1)
    expect(parseErrors[0]).toContain('broken.json')
  })
})

describe('importDocuments', () => {
  it('新增导入：新 id 的系列副本（引用的专题已在库，闭包完整）', async () => {
    const copy = { ...starterSeries, id: 'res_01J9C1C1C1C1C1C1C1C1C1C1C1' }
    const report = await importDocuments([{ file: 'series-copy.json', raw: copy }])
    expect(report.aborted).toBe(false)
    expect(report.added).toEqual([copy.id])
    expect(report.rejected).toHaveLength(0)
    expect((await db.resources.count())).toBe(10) // 9 内置 + 1 新增
  })

  it('重复导入：同 id 同 version 跳过', async () => {
    const entries = [
      { file: 'series.json', raw: starterSeries },
      { file: 't1.json', raw: starterTopic1 },
      { file: 't2.json', raw: starterTopic2 },
    ]
    await importDocuments(entries)
    const report = await importDocuments(entries)
    expect(report.skipped).toHaveLength(3)
    expect(report.added).toHaveLength(0)
  })

  it('同 id 异 version 覆盖更新', async () => {
    const entries = [
      { file: 'series.json', raw: starterSeries },
      { file: 't1.json', raw: starterTopic1 },
      { file: 't2.json', raw: starterTopic2 },
    ]
    await importDocuments(entries)
    const bumped = { ...starterSeries, version: '1.1.0' }
    const report = await importDocuments([{ file: 'series.json', raw: bumped }])
    expect(report.updated).toHaveLength(1)
    expect((await db.resources.get(starterSeries.id))!.version).toBe('1.1.0')
  })

  it('缺件整包拒绝并列出缺件清单，不写入任何文档', async () => {
    const before = await db.resources.count()
    const orphanSeries = {
      ...starterSeries,
      id: 'res_01J9D0D0D0D0D0D0D0D0D0D0D0',
      content: { topicIds: ['res_01J9FFFFFFFFFFF00000000000'] },
      refs: [{ id: 'res_01J9FFFFFFFFFFF00000000000', kind: 'topic', version: '^1.0.0' }],
    }
    const report = await importDocuments([
      { file: 'orphan.json', raw: orphanSeries },
      { file: 'level.json', raw: melodyDictationDoc }, // melody 已在库 → skipped
    ])
    expect(report.aborted).toBe(true)
    expect(report.missing.some((m) => m.id === 'res_01J9FFFFFFFFFFF00000000000')).toBe(true)
    expect(await db.resources.count()).toBe(before)
  })

  it('schema 非法的条目被拒绝，不影响同批合法条目', async () => {
    const bad = { ...starterTopic2, content: {} }
    const report = await importDocuments([
      { file: 'bad.json', raw: bad },
      { file: 'good.json', raw: starterTopic1 },
    ])
    expect(report.rejected).toHaveLength(1)
    expect(report.rejected[0].file).toBe('bad.json')
    // topic1 已随 seed 入库且版本相同 → 跳过
    expect(report.skipped).toEqual([starterTopic1.id])
  })
})

describe('importFromFiles / exportResource', () => {
  it('json 文件导入（topic 已随 seed 入库 → 跳过）', async () => {
    await db.resources.clear()
    await ensureSeeded()
    const bytes = new TextEncoder().encode(JSON.stringify({ ...starterTopic1 }))
    const report = await importFromFiles([{ name: 'topic.json', bytes }])
    expect(report.aborted).toBe(false)
    expect(report.skipped).toEqual([starterTopic1.id])
    expect(report.added).toHaveLength(0)
  })

  it('关卡导出为 JSON；系列导出为自包含 zip 并可回灌', async () => {
    // 先把系列+专题入一举入库，保证闭包完整
    await importDocuments([
      { file: 'series.json', raw: starterSeries },
      { file: 't1.json', raw: starterTopic1 },
      { file: 't2.json', raw: starterTopic2 },
    ])

    const levelId = (noteClickDoc as unknown as { id: string }).id
    const levelExport = await exportResource(levelId)
    expect(levelExport.filename).toMatch(/\.json$/)
    const parsed = JSON.parse(new TextDecoder().decode(levelExport.bytes))
    expect(parsed.kind).toBe('level')

    const seriesExport = await exportResource(starterSeries.id)
    expect(seriesExport.filename).toMatch(/\.zip$/)
    const { entries } = unpackBundle(seriesExport.bytes)
    const docs = entries.map((e) => e.doc)
    // 自包含：1 系列 + 2 专题 + 5 关卡
    expect(docs).toHaveLength(8)
    expect(docs.filter((d) => (d as { kind: string }).kind === 'level')).toHaveLength(5)

    // 回灌：清库 → 仅导入该 zip → 8 份文档全部恢复
    await db.resources.clear()
    await ensureSeeded()
    const report = await importFromFiles([{ name: 'starter.zip', bytes: seriesExport.bytes }])
    expect(report.aborted).toBe(false)
    // 系列+专题已随 seed 入库且版本相同 → 跳过；关卡 seed 已在
    expect(report.added).toHaveLength(0)
    expect(report.skipped).toHaveLength(8) // 8 份文档全部命中 seed（关卡+系列+专题）
  })

  it('缺件库中导出系列被拒绝', async () => {
    await db.resources.clear()
    await ensureSeeded()
    // 系列未入库但手工塞一个引用不存在 topic 的系列
    const orphan = {
      ...starterSeries,
      id: 'res_01J9D0D0D0D0D0D0D0D0D0D0D0',
      content: { topicIds: ['res_01J9FFFFFFFFFFFFFFF0000000'] },
    }
    await db.resources.put({
      id: orphan.id, kind: 'series', version: '1.0.0', title: '孤儿系列', doc: orphan, importedAt: Date.now(), builtIn: 0,
    })
    await expect(exportResource(orphan.id)).rejects.toThrow(/缺少被引用的资源/)
  })
})
