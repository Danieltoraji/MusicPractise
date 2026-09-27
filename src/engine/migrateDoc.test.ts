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

describe('docs/26：组件 bindings 编译为 set 命令节点', () => {
  it('label.text 绑定 → question.loaded / view.entered 双入口各自独立 setText 链，转换后剥离 bindings', () => {
    const raw = v1Doc()
    ;(raw.content.components[0] as unknown as Record<string, unknown>).bindings = { text: '$q.prompt' }
    const doc = migrateDocToV3(raw)
    const logic = doc.content.logic
    // 组件上的 bindings 已剥离（幂等的关键），set 命令节点生成（两个入口各一条独立链）
    expect((doc.content.components[0] as unknown as Record<string, unknown>).bindings).toBeUndefined()
    const callQ = logic.nodes.find((n) => n.id === 'bnd_q_label1_setText_1')
    const callV = logic.nodes.find((n) => n.id === 'bnd_v_label1_setText_1')
    const expected = { kind: 'call', target: 'label1', method: 'setText', args: ['{ text: q.prompt }'] }
    expect(callQ).toMatchObject(expected)
    expect(callV).toMatchObject(expected)
    // 双入口：question.loaded 直连自己的链；view.entered 经 q != null 守卫（true 端口）接自己的链
    expect(logic.nodes.find((n) => n.id === 'bnd_qload')).toMatchObject({ kind: 'on', event: 'question.loaded' })
    expect(logic.nodes.find((n) => n.id === 'bnd_venter')).toMatchObject({ kind: 'on', event: 'view.entered' })
    expect(logic.nodes.find((n) => n.id === 'bnd_v_vguard')).toMatchObject({ kind: 'branch', cond: 'q != null' })
    expect(logic.edges.find((e) => e.from === 'bnd_v_vguard')).toMatchObject({ port: 'true', to: 'bnd_v_label1_setText_1' })
    expect(logic.edges.find((e) => e.from === 'bnd_qload')).toMatchObject({ to: 'bnd_q_label1_setText_1' })
    // lint 零误报（事件名/实例/表达式均合法）
    expect(lintGraphProgram(logic, { componentIds: ['label1', 'btn1'], viewIds: ['main'] })).toEqual([])
  })

  it('无对应 set 命令的槽位丢弃（原运行时 no-op），字面量值转表达式字面量', () => {
    const raw = v1Doc()
    ;(raw.content.components[1] as unknown as Record<string, unknown>).bindings = { text: '$q.nope' } // button 无绑定槽位
    ;(raw.content.components[0] as unknown as Record<string, unknown>).bindings = { text: '固定文案' }
    const warn = console.warn
    const warns: string[] = []
    console.warn = (...args: unknown[]) => warns.push(args.map(String).join(' '))
    try {
      const doc = migrateDocToV3(raw)
      expect(doc.content.logic.nodes.some((n) => n.id.includes('btn1'))).toBe(false)
      const call = doc.content.logic.nodes.find((n) => n.id.includes('label1_setText'))
      expect(call).toMatchObject({ kind: 'call', method: 'setText', args: ["{ text: '固定文案' }"] })
      expect(warns.some((msg) => msg.includes('没有对应的 set 命令'))).toBe(true)
    } finally {
      console.warn = warn
    }
  })

  it('幂等：带 bindings 的文档迁移一次后，二次迁移不再追加节点', () => {
    const raw = v1Doc()
    ;(raw.content.components[0] as unknown as Record<string, unknown>).bindings = { text: '$q.prompt' }
    const once = migrateDocToV3(raw)
    const twice = migrateDocToV3(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
  })
})

describe('docs/27：play 调用 mode 兼容键显式化', () => {
  function v1WithPlay(doActions: unknown[], extra?: { comps?: unknown[] }): ReturnType<typeof v1Doc> {
    const raw = v1Doc({ rules: [{ id: 'p1', on: 'btn1.clicked', do: doActions as never }] })
    const content = raw.content as Record<string, unknown>
    content.components = [
      { id: 'label1', type: 'label' },
      { id: 'btn1', type: 'button' },
      { id: 'sound1', type: 'sound' },
      ...((extra?.comps ?? []) as unknown[]),
    ]
    return raw
  }
  const playArgsOf = (doc: { content: { logic: { nodes: { id: string; args?: string[] }[] } } }): string | undefined =>
    doc.content.logic.nodes.find((n) => n.id.endsWith('p1_d0'))?.args?.[0]

  it('缺 mode 的动态 notes → 补写 mode:\'chord\' 兼容键（旧缺省同时）', () => {
    const doc = migrateDocToV3(v1WithPlay([{ cmd: 'sound1.play', args: { notes: '$q.data.notes', tempo: 90 } }]))
    expect(playArgsOf(doc)).toBe("{ notes: q.data.notes, tempo: 90, mode: 'chord' }")
  })

  it('缺 mode 的多音字面量 → 每音补 t:0；单音不动', () => {
    const doc = migrateDocToV3(
      v1WithPlay([{ cmd: 'sound1.play', args: { notes: [{ midi: 60 }, { midi: 64, dur: '8n' }] } }]),
    )
    expect(playArgsOf(doc)).toBe("{ notes: [{midi: 60, t: 0}, {midi: 64, dur: '8n', t: 0}] }")
    const single = migrateDocToV3(v1WithPlay([{ cmd: 'sound1.play', args: { notes: [{ midi: 60 }] } }]))
    expect(playArgsOf(single)).toBe('{notes: [{midi: 60}]}') // 单音不动（含原字面量格式）
  })

  it('已有 mode 键原样保留（仅规范引号）；synth 同样处理；非 play 命令不触碰', () => {
    const doc = migrateDocToV3(v1WithPlay([{ cmd: 'sound1.play', args: { notes: '$q.data.n', mode: 'seq', tempo: 96 } }]))
    expect(playArgsOf(doc)).toBe("{ notes: q.data.n, mode: 'seq', tempo: 96 }")
    const chordQuoted = migrateDocToV3(v1WithPlay([{ cmd: 'sound1.play', args: { notes: '$q.data.n', mode: 'chord' } }]))
    expect(playArgsOf(chordQuoted)).toBe("{ notes: q.data.n, mode: 'chord' }")
    const show = migrateDocToV3(v1WithPlay([{ cmd: 'label1.show', args: { text: '$q.prompt' } }]))
    const showNode = show.content.logic.nodes.find((n) => n.id.endsWith('p1_d0')) as { args?: string[] } | undefined
    expect(showNode?.args?.[0]).toBe('{text: q.prompt}')
  })

  it('幂等：mode 显式化后二次迁移不再变化', () => {
    const raw = v1WithPlay([{ cmd: 'sound1.play', args: { notes: '$q.data.n' } }])
    const once = migrateDocToV3(raw)
    const twice = migrateDocToV3(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
  })
})

describe('docs/27：scoring 列数值化', () => {
  it('{max:N} 形态的 scoring 行值改写为数值 N，列 type 置 number；图中 q.scoring.max 同步改写', () => {
    const raw = v1Doc({
      rules: [{ id: 'r1', on: 'btn1.clicked', do: [{ cmd: 'sound1.play', args: {} }, { set: 'score', expr: 'q.scoring.max' }] }],
    })
    // v1Doc 的 questions.scoring = { max: 10 } / { max: 5 }
    const doc = migrateDocToV3(raw)
    const scoringCol = doc.content.table.columns.find((c) => c.key === 'scoring')
    expect(scoringCol).toMatchObject({ type: 'number' })
    expect(doc.content.table.rows.map((r) => r.scoring)).toEqual([10, 5])
    const assign = doc.content.logic.nodes.find((n) => n.kind === 'assign') as { value: { expr: string } }
    expect(assign.value.expr).toBe('q.scoring')
  })

  it('幂等：数值化后二次迁移不再变化', () => {
    const raw = v1Doc()
    const once = migrateDocToV3(raw)
    const twice = migrateDocToV3(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
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
