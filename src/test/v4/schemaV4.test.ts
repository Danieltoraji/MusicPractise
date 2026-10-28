/**
 * v4 schema 双校验（docs/44 双校验器口径）：
 * Ajv2020（测试侧，全量错误）与 @cfworker/json-schema（运行时，CSP 禁 eval）对同一 schema 判定一致。
 * 同时覆盖 loadLevelDocV4 装载管线（schema → normalize → 结构/引用校验）。
 */
import { describe, expect, it } from 'vitest'
import Ajv2020 from 'ajv/dist/2020'
import {
  SCHEMA_RAW,
  SCHEMA_V4_LEVEL_ID,
  loadLevelDocV4,
  validateEnvelope,
} from '../../library/validate'
import { minimalLevelDoc, twoTypeLevelDoc } from '../../engine/v4/fixtures'

const ajv = new Ajv2020({ strict: false, allErrors: true })
for (const schema of SCHEMA_RAW) ajv.addSchema(schema as never)
const validate = ajv.getSchema(SCHEMA_V4_LEVEL_ID)

function ajvOk(doc: unknown): boolean {
  return validate!(doc) === true
}

function cfworkerOk(doc: unknown): boolean {
  return validateEnvelope('level', doc).ok
}

function bothReject(doc: unknown): void {
  expect(ajvOk(doc)).toBe(false)
  expect(cfworkerOk(doc)).toBe(false)
}

describe('v4 level JSON Schema', () => {
  it('schema 已注册且可编译（$id 独立于 v1）', () => {
    expect(validate).toBeDefined()
    expect(SCHEMA_V4_LEVEL_ID).toContain('/schemas/v4/level.json')
  })

  it('最小夹具与双题型夹具同时通过 Ajv 与 cfworker', () => {
    for (const doc of [minimalLevelDoc(), twoTypeLevelDoc()]) {
      expect(ajvOk(doc)).toBe(true)
      expect(validate!.errors ?? []).toEqual([])
      expect(cfworkerOk(doc)).toBe(true)
    }
  })

  it('坏文档被两个校验器一致拒绝', () => {
    const noContent = minimalLevelDoc() as unknown as Record<string, unknown>
    delete noContent.content
    bothReject(noContent)

    const badVersion = { ...minimalLevelDoc(), schemaVersion: 3 }
    bothReject(badVersion)

    const badRowPhase = minimalLevelDoc()
    badRowPhase.content.tables.choice.rows[0].phase = 0
    bothReject(badRowPhase)

    const badRunOrder = minimalLevelDoc()
    ;(badRunOrder.content.run as { order: string }).order = 'bogus'
    bothReject(badRunOrder)

    const unknownFlowKind = minimalLevelDoc()
    ;(unknownFlowKind.content.flow.nodes as unknown[]).push({ id: 'f_x', kind: 'teleport' })
    bothReject(unknownFlowKind)

    const badStateType = minimalLevelDoc()
    ;(badStateType.content.types[0].state as { type: string }[])[0].type = 'integer'
    bothReject(badStateType)

    const tooManyComponents = minimalLevelDoc()
    tooManyComponents.content.shell.components = Array.from({ length: 65 }, (_, i) => ({
      id: `c_${i}`,
      type: 'label',
    }))
    bothReject(tooManyComponents)
  })

  it('v4.1 题型内视图：surface.views/initialView/组件 view/behavior setView 双校验器一致接受', () => {
    const doc = minimalLevelDoc()
    const type = doc.content.types[0]
    type.surface.views = [{ id: 'intro', name: '读题' }, { id: 'answer' }]
    type.surface.initialView = 'intro'
    type.surface.components[0].view = 'intro'
    type.surface.components[1].view = 'answer'
    type.behavior.nodes.push({ id: 'b_view', kind: 'setView', view: 'answer' })
    expect(ajvOk(doc)).toBe(true)
    expect(cfworkerOk(doc)).toBe(true)
    expect(loadLevelDocV4(doc).ok).toBe(true)

    const emptyViews = minimalLevelDoc()
    emptyViews.content.types[0].surface.views = []
    bothReject(emptyViews)

    const tooManyViews = minimalLevelDoc()
    tooManyViews.content.types[0].surface.views = Array.from({ length: 17 }, (_, i) => ({ id: `v_${i}` }))
    bothReject(tooManyViews)
  })

  it('v4.2 behavior foreach 被双校验器一致接受（共享节点）', () => {
    const doc = minimalLevelDoc()
    doc.content.types[0].behavior.nodes.push({ id: 'b_fe', kind: 'foreach', items: 'q.options', itemVar: 'item' })
    expect(ajvOk(doc)).toBe(true)
    expect(cfworkerOk(doc)).toBe(true)
    expect(loadLevelDocV4(doc).ok).toBe(true)
  })

  it('cfworker 错误信息带中文位置（v4 路径格式化）', () => {
    const doc = minimalLevelDoc()
    doc.content.tables.choice.rows[0].phase = 0
    const result = validateEnvelope('level', doc)
    expect(result.ok).toBe(false)
    expect(result.errors.join('\n')).toMatch(/题型/)
  })
})

describe('loadLevelDocV4 装载管线', () => {
  it('合法 v4 文档返回 normalize 后的 doc，无错无警告', () => {
    const result = loadLevelDocV4(minimalLevelDoc())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc.schemaVersion).toBe(4)
    expect(result.doc.content.run.order).toBe('manifest')
    expect(result.lintWarnings).toEqual([])
  })

  it('缺省 run 字段由 normalize 补全后仍装载成功', () => {
    const doc = minimalLevelDoc()
    delete (doc.content as { run?: unknown }).run
    const result = loadLevelDocV4(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doc.content.run).toEqual({
      order: 'manifest',
      count: null,
      seed: null,
      shuffleWithinPhase: true,
    })
  })

  it('版本/kind 不符返回可读错误', () => {
    const v3 = { ...minimalLevelDoc(), schemaVersion: 3 }
    const r1 = loadLevelDocV4(v3)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.errors.join('\n')).toMatch(/schemaVersion 3 不受支持|格式为 4/)

    const notLevel = { ...minimalLevelDoc(), kind: 'series' }
    const r2 = loadLevelDocV4(notLevel)
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.errors.join('\n')).toMatch(/kind 不是 level/)

    const r3 = loadLevelDocV4('not a doc')
    expect(r3.ok).toBe(false)
  })

  it('结构/引用错误被拦截（悬空题单、未知列、重复行 id）', () => {
    const danglingManifest = minimalLevelDoc()
    danglingManifest.content.manifest = { entries: [{ type: 'choice', row: 'row_99' }] }
    const r1 = loadLevelDocV4(danglingManifest)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.errors.join('\n')).toMatch(/不存在的行/)

    const unknownContentCol = minimalLevelDoc()
    ;(unknownContentCol.content.tables.choice.rows[0] as Record<string, unknown>).mystery = 1
    const r2 = loadLevelDocV4(unknownContentCol)
    expect(r2.ok).toBe(false)

    const dupRow = minimalLevelDoc()
    dupRow.content.tables.choice.rows[1].id = 'row_01'
    const r3 = loadLevelDocV4(dupRow)
    expect(r3.ok).toBe(false)
    if (!r3.ok) expect(r3.errors.join('\n')).toMatch(/重复/)
  })

  it('草稿行进入显式题单 → 装载成功但带 lint 警告', () => {
    const doc = minimalLevelDoc()
    doc.content.manifest = { entries: [{ type: 'choice', row: 'row_03' }] }
    const result = loadLevelDocV4(doc)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.lintWarnings.join('\n')).toMatch(/草稿/)
  })
})
