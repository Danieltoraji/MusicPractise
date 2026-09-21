// migrateDocToV3 单测：v1 文档 → v3（视图 + 数据表 + 行门控装载子图）
import { describe, expect, it } from 'vitest'
import { migrateDocToV3, jsonToExprSource } from './migrateDoc'
import { lintGraphProgram } from './graphProgram'

function v1Doc(overrides?: { questions?: unknown[]; views?: unknown[]; rules?: unknown[] }) {
  return {
    schemaVersion: 1,
    kind: 'level',
    id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A2',
    version: '1.0.0',
    meta: { title: '迁移测试' },
    refs: [],
    content: {
      components: [
        { id: 'label1', type: 'label', visible: true, layout: { x: 0, y: 0, w: 100, h: 40 } },
        { id: 'btn1', type: 'button' },
      ],
      logic: {
        variables: { score: 0 },
        rules: overrides?.rules ?? [{ id: 'r1', on: 'btn1.clicked', do: [{ cmd: 'level.next' }] }],
      },
      questions:
        overrides?.questions ?? [
          { id: 'q1', prompt: { text: '第一题' }, data: { a: 1 }, scoring: { max: 10 } },
          { id: 'q2', prompt: { text: '第二题' }, data: { a: 2 }, scoring: { max: 5 }, hints: [{ text: '提示' }] },
        ],
      ...(overrides?.views ? { views: overrides.views } : {}),
      flow: { order: 'sequential' },
    },
  }
}

describe('migrateDocToV3', () => {
  it('信封升级：schemaVersion 3、视图默认主视图、组件归属视图、questions 移除', () => {
    const doc = migrateDocToV3(v1Doc())
    expect(doc.schemaVersion).toBe(3)
    expect(doc.content.views).toEqual([{ id: 'main', name: '主视图' }])
    expect(doc.content.components.every((c) => c.view === 'main')).toBe(true)
    expect('questions' in doc.content).toBe(false)
  })

  it('表格列推导：各题顶层字段并集（去 id/logicPatch），缺省单元格补 null', () => {
    const doc = migrateDocToV3(v1Doc())
    expect(doc.content.table.columns.map((c) => c.key)).toEqual(['prompt', 'data', 'scoring', 'hints'])
    expect(doc.content.table.rows[0].hints).toBeNull()
    expect(doc.content.table.rows[1].hints).toEqual([{ text: '提示' }])
    expect(doc.content.table.rows[1].data).toEqual({ a: 2 })
  })

  it('logicPatch.variables 编译为行门控装载子图且节点前置；__row 变量补声明', () => {
    const doc = migrateDocToV3(
      v1Doc({
        questions: [
          { id: 'q1', data: {}, scoring: { max: 10 } },
          { id: 'q2', data: {}, scoring: { max: 10 }, logicPatch: { variables: { answered: false, taps: [1, 2] } } },
        ],
      }),
    )
    const ids = doc.content.logic.nodes.map((n) => n.id)
    // 装载子图按「行索引」命名且在最前：q0 无补丁跳过，q1（索引 1）的 on→gate→各变量赋值
    expect(ids.slice(0, 4)).toEqual(['q1_load', 'q1_gate', 'q1_var_answered', 'q1_var_taps'])
    expect(doc.content.logic.nodes.find((n) => n.id === 'q1_gate')).toMatchObject({ kind: 'branch', cond: 'v.__row == 1' })
    expect(doc.content.logic.nodes.find((n) => n.id === 'q1_var_taps')).toMatchObject({
      kind: 'assign',
      target: 'taps',
      value: { expr: '[1, 2]' },
    })
    // gate(true) → 变量赋值链
    const gateOut = doc.content.logic.edges.find((e) => e.from === 'q1_gate')
    expect(gateOut).toMatchObject({ port: 'true' })
    // __row 与补丁变量补进声明，lint 零「未声明变量」误报
    expect(doc.content.logic.variables).toMatchObject({ __row: null, answered: null, taps: null })
    expect(lintGraphProgram(doc.content.logic, { componentIds: ['label1', 'btn1'], viewIds: ['main'] })).toEqual([])
  })

  it('无 logicPatch 的文档不引入任何装载子图/额外变量', () => {
    const doc = migrateDocToV3(v1Doc())
    expect(doc.content.logic.nodes.some((n) => n.id.includes('_load'))).toBe(false)
    expect('__row' in (doc.content.logic.variables ?? {})).toBe(false)
  })

  it('已有 views 的 v1 文档沿用之（不强制默认主视图）', () => {
    const doc = migrateDocToV3(v1Doc({ views: [{ id: 'title' }, { id: 'quiz', template: true }] as never }))
    expect(doc.content.views).toEqual([{ id: 'title' }, { id: 'quiz' }]) // 沿用视图，且剥离 template（docs/25）
    expect(doc.content.components.every((c) => c.view === 'title')).toBe(true)
  })

  it('幂等：v3 输入原样返回（逻辑仍是 v2）', () => {
    const once = migrateDocToV3(v1Doc())
    const twice = migrateDocToV3(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
  })

  it('确定性：同输入两次迁移逐字段相等', () => {
    expect(migrateDocToV3(v1Doc({ questions: [{ id: 'q', data: { x: 1 }, logicPatch: { variables: { a: 1 } } }] }))).toEqual(
      migrateDocToV3(v1Doc({ questions: [{ id: 'q', data: { x: 1 }, logicPatch: { variables: { a: 1 } } }] })),
    )
  })

  it('非 level kind / 不支持的 schemaVersion 报错', () => {
    expect(() => migrateDocToV3({ ...v1Doc(), kind: 'series' })).toThrow(/kind/)
    expect(() => migrateDocToV3({ ...v1Doc(), schemaVersion: 2 })).toThrow(/schemaVersion/)
  })

  it('logicPatch.appendRules 编译为行门控片段：on 入口插 v.__row 门控（评审 P2-15 固化）', () => {
    const doc = migrateDocToV3(
      v1Doc({
        questions: [
          { id: 'q1', data: {}, scoring: { max: 10 } },
          {
            id: 'q2',
            data: {},
            scoring: { max: 10 },
            logicPatch: {
              appendRules: [
                {
                  id: 'p1',
                  on: 'x.ping',
                  when: ['v.score >= 0'],
                  do: [{ set: 'score', expr: 'v.score + 1' }],
                  else: [{ set: 'score', expr: 'v.score - 1' }],
                },
              ],
            },
          },
        ],
      }),
    )
    const nodes = doc.content.logic.nodes
    const edges = doc.content.logic.edges
    // 片段节点已前缀；on 入口原样保留（事件不变）
    expect(nodes.find((n) => n.id === 'q1_p1_on')).toMatchObject({ kind: 'on', event: 'x.ping' })
    // on 的唯一出边改为指向行门控（无端口），门控 true 出口接原 when 条件分支——when/else 端口边不受影响
    expect(nodes.find((n) => n.id === 'q1_p1_on_rowgate')).toMatchObject({ kind: 'branch', cond: 'v.__row == 1' })
    expect(edges.find((e) => e.from === 'q1_p1_on')).toMatchObject({ to: 'q1_p1_on_rowgate' })
    const gateTrue = edges.find((e) => e.from === 'q1_p1_on_rowgate')
    expect(gateTrue).toMatchObject({ port: 'true' })
    expect(gateTrue!.to).not.toBe('q1_p1_on_rowgate')
    // lint 零误报
    expect(lintGraphProgram(doc.content.logic, { componentIds: ['label1', 'btn1'], viewIds: ['main'] })).toEqual([])
  })

  it('patch 前缀 id 与基础图节点撞车时诚实抛错（评审 P2-3）', () => {
    const raw = v1Doc({
      questions: [{ id: 'q1', data: {}, scoring: { max: 10 }, logicPatch: { variables: { answered: false } } }],
    })
    ;(raw.content as Record<string, unknown>).logic = {
      logicVersion: 2,
      variables: { score: 0 },
      nodes: [{ id: 'q0_load', kind: 'on', event: 'question.loaded' }],
      edges: [],
    }
    expect(() => migrateDocToV3(raw)).toThrow(/冲突/)
  })
})

describe('jsonToExprSource（Json → 表达式字面量）', () => {
  it('标量 / 数组 / 对象（键为标识符）', () => {
    expect(jsonToExprSource(null)).toBe('null')
    expect(jsonToExprSource('你好')).toBe('"你好"')
    expect(jsonToExprSource(3.5)).toBe('3.5')
    expect(jsonToExprSource(true)).toBe('true')
    expect(jsonToExprSource([1, 'a'])).toBe('[1, "a"]')
    expect(jsonToExprSource({ ms: 30, repeat: false })).toBe('{ ms: 30, repeat: false }')
    expect(jsonToExprSource({ deep: { x: [1] } })).toBe('{ deep: { x: [1] } }')
  })

  it('科学计数法展开为普通十进制（表达式数字词法不支持 e 记法，评审 P2-1）', () => {
    expect(jsonToExprSource(1e21)).toBe('1000000000000000000000')
    expect(jsonToExprSource(1e-7)).toBe('0.0000001')
  })

  it('控制字符/孤立代理对/非有限数诚实拒绝（评审 P2-2）', () => {
    expect(() => jsonToExprSource('a\u0001b')).toThrow(/控制字符/)
    expect(() => jsonToExprSource('\ud800')).toThrow(/代理对/)
    expect(() => jsonToExprSource(Infinity)).toThrow(/无法用表达式字面量表示/)
  })
})
