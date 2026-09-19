import { describe, expect, it } from 'vitest'
import type { Json } from './expr'
import { lintGraphProgram, type GNode, type GraphProgram } from './graphProgram'
import { jsonToExpr, migrateLogicV1toV2 } from './migrate'
import type { LogicProgram } from './logic'

// v1 夹具：内置关卡转为 v2 前的原始 ECA 形态（迁移器与行为等价测试的永久输入）
import noteClickDoc from '../sample/fixtures/note-click.v1.json'
import theoryChoiceDoc from '../sample/fixtures/theory-choice.v1.json'
import melodyDictationDoc from '../sample/fixtures/melody-dictation.v1.json'
import timedReactionDoc from '../sample/fixtures/timed-reaction.v1.json'
import noteSpellingDoc from '../sample/fixtures/note-spelling.v1.json'
import clefTestDoc from '../sample/fixtures/clef-test.v1.json'
import rhythmFollowDoc from '../sample/fixtures/rhythm-follow.v1.json'
import tuneIntroDoc from '../sample/fixtures/tune-intro.v1.json'

describe('jsonToExpr', () => {
  it('$ 引用与 $expr: 去前缀', () => {
    expect(jsonToExpr('$q.data.target')).toBe('q.data.target')
    expect(jsonToExpr('$v.score')).toBe('v.score')
    expect(jsonToExpr('$event.midi')).toBe('event.midi')
    expect(jsonToExpr('$expr:rhythmScore(v.taps, q.data.grid, 120)')).toBe('rhythmScore(v.taps, q.data.grid, 120)')
  })

  it('标量/数组/对象字面量', () => {
    expect(jsonToExpr(42)).toBe('42')
    expect(jsonToExpr(true)).toBe('true')
    expect(jsonToExpr(null)).toBe('null')
    expect(jsonToExpr('plain text')).toBe("'plain text'")
    expect(jsonToExpr("it's")).toBe("'it\\'s'")
    expect(jsonToExpr([1, 'a'])).toBe("[1, 'a']")
    expect(jsonToExpr({ notes: [{ midi: 60 }], tempo: 90 })).toBe('{notes: [{midi: 60}], tempo: 90}')
    expect(jsonToExpr({})).toBe('{}')
  })

  it('非标识符键抛错', () => {
    expect(() => jsonToExpr({ 'my key': 1 })).toThrow(/不是标识符/)
  })
})

describe('migrateLogicV1toV2', () => {
  it('无 when：on 直连 do 链；死 else 被丢弃', () => {
    const prog: LogicProgram = {
      variables: { score: 0 },
      rules: [
        { id: 'r1', on: 'level.started', do: [{ cmd: 'label1.show', args: { text: 'hi' } }, { set: 'score', expr: '0' }] },
        { id: 'r2', on: 'level.started', do: [{ set: 'score', expr: '1' }], else: [{ set: 'score', expr: '9' }] },
      ],
    }
    const g = migrateLogicV1toV2(prog)
    expect(g.logicVersion).toBe(2)
    expect(g.variables).toEqual({ score: 0 })
    const kinds = Object.fromEntries(g.nodes.map((n) => [n.id, n.kind]))
    expect(kinds['r1_on']).toBe('on')
    expect(kinds['r1_d0']).toBe('call')
    expect(kinds['r1_d1']).toBe('assign')
    // r2 无 when：else 死代码丢弃，set 直连 on
    expect(kinds['r2_d0']).toBe('assign')
    expect(g.nodes.some((n) => n.id.startsWith('r2_e'))).toBe(false)
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'r1_on', to: 'r1_d0' }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'r1_d0', to: 'r1_d1' }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'r2_on', to: 'r2_d0' }))
  })

  it('有 when：branch 结构（true/false 端口）与参数转换', () => {
    const prog: LogicProgram = {
      rules: [
        {
          id: 'chk',
          on: 'staff1.noteClicked',
          when: ['event.midi == q.data.answer', 'v.done == false'],
          do: [{ cmd: 'sound1.play', args: { notes: '$q.data.rewardChord' } }],
          else: [{ emit: 'app:miss', payload: { midi: '$event.midi' } }],
        },
      ],
    }
    const g = migrateLogicV1toV2(prog)
    const branch = g.nodes.find((n) => n.id === 'chk_cond')
    expect(branch).toMatchObject({ kind: 'branch', cond: '(event.midi == q.data.answer) && (v.done == false)' })
    const call = g.nodes.find((n) => n.id === 'chk_d0') as Extract<GNode, { kind: 'call' }>
    expect(call).toMatchObject({ target: 'sound1', method: 'play' })
    expect(call.args).toEqual(['{notes: q.data.rewardChord}'])
    const emit = g.nodes.find((n) => n.id === 'chk_e0') as Extract<GNode, { kind: 'emit' }>
    expect(emit).toMatchObject({ event: 'app:miss' })
    expect(emit.payload).toEqual({ midi: 'event.midi' })
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'chk_cond', to: 'chk_d0', port: 'true' }))
    expect(g.edges).toContainEqual(expect.objectContaining({ from: 'chk_cond', to: 'chk_e0', port: 'false' }))
    expect(g.edges).toContainEqual({ from: 'chk_on', id: expect.any(String), to: 'chk_cond' })
  })

  it('空 do：孤立 on 节点；规则 id 重复抛错', () => {
    const g = migrateLogicV1toV2({ rules: [{ id: 'r', on: 'app:tick', do: [] }] })
    expect(g.nodes).toHaveLength(1)
    expect(g.edges).toHaveLength(0)
    expect(() =>
      migrateLogicV1toV2({
        rules: [
          { id: 'r', on: 'app:tick', do: [] },
          { id: 'r', on: 'app:tock', do: [] },
        ],
      }),
    ).toThrow(/id 重复/)
  })

  it('args 边界：标量/数组包装为单参数；emit 非对象 payload 包装进 value（已知限制，docs/12 §10）', () => {
    const g = migrateLogicV1toV2({
      rules: [
        { id: 'a', on: 'app:x', do: [{ cmd: 'label1.show', args: 'plain' }] },
        { id: 'b', on: 'app:x', do: [{ cmd: 'label1.show', args: [1, 2] }] },
        { id: 'c', on: 'app:x', do: [{ emit: 'app:y', payload: 5 }] },
      ],
    })
    const callA = g.nodes.find((n) => n.id === 'a_d0') as Extract<GNode, { kind: 'call' }>
    expect(callA.args).toEqual(["'plain'"])
    const callB = g.nodes.find((n) => n.id === 'b_d0') as Extract<GNode, { kind: 'call' }>
    expect(callB.args).toEqual(['[1, 2]'])
    // ECA 引擎原样派发标量 payload（event === 5）；迁移后形状变为 {value: 5}——已记录的行为差异
    const emit = g.nodes.find((n) => n.id === 'c_d0') as Extract<GNode, { kind: 'emit' }>
    expect(emit.payload).toEqual({ value: '5' })
  })

  it('when 混合布尔优先级：逐项加括号保护', () => {
    const g = migrateLogicV1toV2({
      rules: [{ id: 'r', on: 'app:x', when: ['v.a ? v.b : v.c', 'v.d'], do: [] }],
    })
    const branch = g.nodes.find((n) => n.kind === 'branch') as Extract<GNode, { kind: 'branch' }>
    expect(branch.cond).toBe('(v.a ? v.b : v.c) && (v.d)')
  })

  it('自环 emit：单节点触发环被 lint 报告', () => {
    const g = migrateLogicV1toV2({
      rules: [{ id: 'r', on: 'app:x', do: [{ emit: 'app:x' }] }],
    })
    const errors = lintGraphProgram(g)
    expect(errors.some((x) => x.startsWith('emit 触发环'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Golden：8 个内置关卡 v1 → v2 结构迁移
// ---------------------------------------------------------------------------

const SAMPLES: [string, unknown][] = [
  ['note-click', noteClickDoc],
  ['theory-choice', theoryChoiceDoc],
  ['melody-dictation', melodyDictationDoc],
  ['timed-reaction', timedReactionDoc],
  ['note-spelling', noteSpellingDoc],
  ['clef-test', clefTestDoc],
  ['rhythm-follow', rhythmFollowDoc],
  ['tune-intro', tuneIntroDoc],
]

describe('golden：内置关卡迁移', () => {
  for (const [name, raw] of SAMPLES) {
    it(`${name}：迁移零错误且结构完整`, () => {
      const doc = raw as {
        content: { components: { id: string }[]; questions: { logicPatch?: { variables?: Record<string, Json> } }[]; logic: LogicProgram }
      }
      const v1 = doc.content.logic
      const g: GraphProgram = migrateLogicV1toV2(v1)

      // 装载期 lint 全绿（语法/引用/环检测层面）——迁移正确性的强断言
      // extraVariableKeys 对齐真实管线：题目 logicPatch.variables 声明的变量豁免
      const compIds = doc.content.components.map((c) => c.id)
      const extraVars = doc.content.questions.flatMap((q) => Object.keys(q.logicPatch?.variables ?? {}))
      expect(lintGraphProgram(g, { componentIds: compIds, extraVariableKeys: extraVars })).toEqual([])

      // 处理器数量与变量保真
      expect(g.nodes.filter((n) => n.kind === 'on')).toHaveLength(v1.rules.length)
      expect(Object.keys(g.variables ?? {})).toEqual(Object.keys(v1.variables ?? {}))

      // 全部节点可从某 on 节点沿执行边到达（除孤立 on 外不应有死子图）
      const onIds = g.nodes.filter((n) => n.kind === 'on').map((n) => n.id)
      const adj = new Map<string, string[]>()
      for (const e of g.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to])
      const seen = new Set<string>()
      const stack = [...onIds]
      while (stack.length) {
        const id = stack.pop()!
        if (seen.has(id)) continue
        seen.add(id)
        for (const next of adj.get(id) ?? []) stack.push(next)
      }
      for (const node of g.nodes) {
        expect(seen.has(node.id)).toBe(true)
      }
    })
  }

  it('note-click 抽查：check-answer 规则的图形状与表达式转换', () => {
    const doc = noteClickDoc as unknown as { content: { logic: LogicProgram } }
    const rule = doc.content.logic.rules.find((r) => r.id === 'check-answer')!
    const g = migrateLogicV1toV2(doc.content.logic)
    expect(rule.when).toBeTruthy()
    const branch = g.nodes.find((n) => n.id === 'check-answer_cond') as Extract<GNode, { kind: 'branch' }>
    expect(branch.cond).toBe(`(${rule.when![0]})`)
    const d0 = g.nodes.find((n) => n.id === 'check-answer_d0') as Extract<GNode, { kind: 'call' }>
    expect(d0.target).toBe('sound1')
    expect(d0.method).toBe('play')
    expect(d0.args[0]).toContain('q.data.rewardChord')
  })
})
