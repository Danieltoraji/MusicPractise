import { describe, expect, it } from 'vitest'
import type { Json } from './expr'
import { lintGraphProgram, type GNode, type GraphProgram } from './graphProgram'
import { jsonToExpr, migrateLogicV1toV2 } from './migrate'
import type { LogicProgram } from './logic'

import noteClickDoc from '../sample/note-click.level.json'
import theoryChoiceDoc from '../sample/theory-choice.level.json'
import melodyDictationDoc from '../sample/melody-dictation.level.json'
import timedReactionDoc from '../sample/timed-reaction.level.json'
import noteSpellingDoc from '../sample/note-spelling.level.json'
import clefTestDoc from '../sample/clef-test.level.json'
import rhythmFollowDoc from '../sample/rhythm-follow.level.json'
import tuneIntroDoc from '../sample/tune-intro.level.json'

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
