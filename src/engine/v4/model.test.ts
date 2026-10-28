import { describe, expect, it } from 'vitest'
import {
  LOCAL_ID_PATTERN,
  ROW_RESERVED_KEYS,
  SCHEMA_LIMITS_V4,
  allRows,
  cloneLevelDocV4,
  countRows,
  getRow,
  getRowIndex,
  getTable,
  getType,
  initStateObject,
  isV4LocalId,
  newLocalId,
  newUniqueLocalId,
  normalizeLevelDocV4,
  normalizeQuestionResult,
  questionContentOfRow,
} from './model'
import { minimalLevelDoc, twoTypeLevelDoc } from './fixtures'

describe('v4 model：id 形态与保留字', () => {
  it('LOCAL_ID_PATTERN 接受合法本地 id、拒绝点号/数字开头/超长/空串', () => {
    expect(isV4LocalId('row_01')).toBe(true)
    expect(isV4LocalId('choice-listen')).toBe(true)
    expect(isV4LocalId('_x')).toBe(true)
    expect(isV4LocalId('a.b')).toBe(false)
    expect(isV4LocalId('1row')).toBe(false)
    expect(isV4LocalId('')).toBe(false)
    expect(isV4LocalId(42)).toBe(false)
    expect(isV4LocalId('a'.repeat(64))).toBe(true)
    expect(isV4LocalId('a'.repeat(65))).toBe(false)
    expect(LOCAL_ID_PATTERN.test('row_01')).toBe(true)
  })

  it('newLocalId 生成前缀_8 位小写字母数字，newUniqueLocalId 不重复', () => {
    const id = newLocalId('row')
    expect(id).toMatch(/^row_[a-z0-9]{8}$/)
    expect(isV4LocalId(id)).toBe(true)
    const used = new Set<string>()
    for (let i = 0; i < 32; i++) {
      const next = newUniqueLocalId('node', used)
      expect(used.has(next)).toBe(false)
      used.add(next)
    }
  })

  it('行保留字段包含 id/draft/phase/order/state', () => {
    expect([...ROW_RESERVED_KEYS]).toEqual(['id', 'draft', 'phase', 'order', 'state'])
  })

  it('限额常量均为正数且覆盖 docs/53 §4 的关键上限', () => {
    for (const value of Object.values(SCHEMA_LIMITS_V4)) expect(value).toBeGreaterThan(0)
    expect(SCHEMA_LIMITS_V4.types).toBe(12)
    expect(SCHEMA_LIMITS_V4.rowsPerType).toBe(512)
    expect(SCHEMA_LIMITS_V4.columnsPerType).toBe(32)
    expect(SCHEMA_LIMITS_V4.rowsTotal).toBe(1024)
    expect(SCHEMA_LIMITS_V4.exprLength).toBe(2000)
  })
})

describe('v4 model：normalize', () => {
  it('空对象补出完整结构容器与 run 默认值', () => {
    const doc = normalizeLevelDocV4({})
    expect(doc.schemaVersion).toBe(4)
    expect(doc.kind).toBe('level')
    expect(doc.content.shell).toEqual({ views: [], components: [] })
    expect(doc.content.types).toEqual([])
    expect(doc.content.tables).toEqual({})
    expect(doc.content.flow).toEqual({ logicVersion: 3, kind: 'flow', nodes: [], edges: [] })
    expect(doc.content.run).toEqual({ order: 'manifest', count: null, seed: null, shuffleWithinPhase: true })
    expect(doc.content.manifest).toBeUndefined()
  })

  it('对完整夹具是恒等变换（normalize(normalize(x)) == normalize(x)）', () => {
    const doc = minimalLevelDoc()
    const once = normalizeLevelDocV4(doc)
    expect(once).toEqual(doc)
    const twice = normalizeLevelDocV4(once)
    expect(twice).toEqual(once)
  })

  it('不修改入参，且剥离值为 undefined 的字段', () => {
    const raw = {
      content: {
        flow: {
          nodes: [{ id: 'f_start', kind: 'start', x: undefined }],
          edges: [],
        },
      },
    }
    const before = JSON.stringify(raw)
    const doc = normalizeLevelDocV4(raw)
    expect(JSON.stringify(raw)).toBe(before)
    expect(doc.content.flow.nodes[0]).toEqual({ id: 'f_start', kind: 'start' })
  })

  it('tables 逐表补 columns/rows，types 保留声明顺序', () => {
    const doc = normalizeLevelDocV4({
      content: {
        types: [{ id: 'b', name: 'B' }, { id: 'a', name: 'A' }],
        tables: { a: { columns: [{ key: 'x' }] }, b: { rows: [{ id: 'row_1' }] } },
      },
    })
    expect(doc.content.types.map((t) => t.id)).toEqual(['b', 'a'])
    expect(doc.content.tables.b).toEqual({ columns: [], rows: [{ id: 'row_1' }] })
    expect(doc.content.tables.a).toEqual({ columns: [{ key: 'x' }], rows: [] })
  })

  it('题型 surface 视图/初始视图归一化；未声明视图时不产生空 views（v4.1）', () => {
    const doc = normalizeLevelDocV4({
      content: {
        types: [
          {
            id: 't',
            name: 'T',
            surface: {
              views: [{ id: 'intro' }, { id: 'answer', name: '作答' }],
              initialView: 'intro',
              components: [{ id: 'prompt', type: 'label', view: 'intro' }],
            },
            behavior: {},
          },
        ],
      },
    })
    const surface = doc.content.types[0].surface
    expect(surface.views).toEqual([{ id: 'intro' }, { id: 'answer', name: '作答' }])
    expect(surface.initialView).toBe('intro')
    expect(surface.components[0].view).toBe('intro')

    const noViews = normalizeLevelDocV4({ content: { types: [{ id: 't', name: 'T', surface: { components: [] } }] } })
    expect('views' in noViews.content.types[0].surface).toBe(false)
    expect('initialView' in noViews.content.types[0].surface).toBe(false)
  })

  it('显式 manifest 归一化；run.order 非 shuffle 掉落为 manifest', () => {
    const doc = normalizeLevelDocV4({
      content: {
        manifest: { entries: [{ type: 'choice', row: 'row_01', args: { a: 1 } }] },
        run: { order: 'bogus', count: 3, seed: 'abc', shuffleWithinPhase: false },
      },
    })
    expect(doc.content.manifest).toEqual({ entries: [{ type: 'choice', row: 'row_01', args: { a: 1 } }] })
    expect(doc.content.run).toEqual({ order: 'manifest', count: 3, seed: 'abc', shuffleWithinPhase: false })
  })
})

describe('v4 model：只读查询与克隆', () => {
  it('getType/getTable/getRow/getRowIndex 命中与未命中', () => {
    const doc = twoTypeLevelDoc()
    expect(getType(doc, 'listen')?.name).toBe('听音')
    expect(getType(doc, 'nope')).toBeUndefined()
    expect(getTable(doc, 'choice')?.rows).toHaveLength(3)
    expect(getTable(doc, 'nope')).toBeUndefined()
    expect(getRow(doc, 'listen', 'row_12')?.prompt).toBe('B')
    expect(getRow(doc, 'listen', 'nope')).toBeUndefined()
    expect(getRowIndex(doc, 'listen', 'row_13')).toBe(2)
    expect(getRowIndex(doc, 'listen', 'nope')).toBe(-1)
    expect(getRowIndex(doc, 'nope', 'row_01')).toBe(-1)
  })

  it('allRows/countRows 覆盖全部题型并按声明顺序', () => {
    const doc = twoTypeLevelDoc()
    const rows = allRows(doc)
    expect(rows).toHaveLength(3 + 4)
    expect(rows[0]).toMatchObject({ typeId: 'choice', rowIndex: 0, row: { id: 'row_01' } })
    expect(rows[3]).toMatchObject({ typeId: 'listen', rowIndex: 0, row: { id: 'row_11' } })
    expect(countRows(doc)).toBe(7)
  })

  it('cloneLevelDocV4 深拷贝：改副本不影响原文档', () => {
    const doc = minimalLevelDoc()
    const copy = cloneLevelDocV4(doc)
    copy.content.types[0].name = '改名'
    copy.content.tables.choice.rows[0].prompt = '改题'
    expect(doc.content.types[0].name).toBe('听音选择')
    expect(doc.content.tables.choice.rows[0].prompt).toBe('听一听，这是什么音？')
  })
})

describe('v4 model：运行时/编辑器共用的状态初值与题目投影（W13）', () => {
  it('initStateObject 按字段深拷贝初值；undefined 字段表 → 空对象', () => {
    const fields = [
      { key: 'score', type: 'number' as const, init: 0 },
      { key: 'tags', type: 'json' as const, init: { list: [1, 2] } },
    ]
    const state = initStateObject(fields)
    expect(state).toEqual({ score: 0, tags: { list: [1, 2] } })
    // 深拷贝：改投影不影响字段定义
    ;(state.tags as { list: number[] }).list.push(3)
    expect(fields[1].init).toEqual({ list: [1, 2] })
    expect(initStateObject(undefined)).toEqual({})
  })

  it('questionContentOfRow 排除平台元数据并补 q.id；内容列原样保留', () => {
    const q = questionContentOfRow({
      id: 'row_01',
      draft: true,
      phase: 2,
      order: 3,
      prompt: '题面',
      options: ['Do', 'Re'],
      scoring: 10,
    })
    expect(q).toEqual({ prompt: '题面', options: ['Do', 'Re'], scoring: 10, id: 'row_01' })
    expect(questionContentOfRow({ id: 'row_02' })).toEqual({ id: 'row_02' })
  })
})

describe('v4 model：QuestionResult 归一化（docs/53 §9）', () => {
  it('空对象 → answered；字段完整时原样保留', () => {
    expect(normalizeQuestionResult({})).toEqual({ status: 'answered' })
    expect(
      normalizeQuestionResult({
        status: 'timeout',
        correct: false,
        scoreDelta: 5,
        payload: { x: 1 },
        message: '超时',
      }),
    ).toEqual({ status: 'timeout', correct: false, scoreDelta: 5, payload: { x: 1 }, message: '超时' })
  })

  it('非对象/非法 status/correct/scoreDelta/message → status:error', () => {
    for (const bad of [null, 42, 'x', [1, 2]]) {
      expect(normalizeQuestionResult(bad)).toMatchObject({ status: 'error' })
    }
    expect(normalizeQuestionResult({ status: 'bogus' })).toMatchObject({ status: 'error' })
    expect(normalizeQuestionResult({ correct: 'yes' })).toMatchObject({ status: 'error' })
    expect(normalizeQuestionResult({ scoreDelta: Number.NaN })).toMatchObject({ status: 'error' })
    expect(normalizeQuestionResult({ scoreDelta: Number.POSITIVE_INFINITY })).toMatchObject({ status: 'error' })
    expect(normalizeQuestionResult({ message: 1 })).toMatchObject({ status: 'error' })
  })

  it('未知字段被丢弃', () => {
    expect(normalizeQuestionResult({ foo: 1, status: 'skipped' })).toEqual({ status: 'skipped' })
  })
})
