import { describe, expect, it, vi } from 'vitest'
import type { LevelDoc, Question } from '../engine/level'
import type { Json } from '../engine/expr'
import { LevelSession, type SessionHost } from './levelSession'

function makeDoc(overrides?: {
  questions?: Question[]
  rules?: LevelDoc['content']['logic']['rules']
  pass?: string
  variables?: Record<string, Json>
}): LevelDoc {
  const questions: Question[] = overrides?.questions ?? [
    { id: 'q1', data: { answerMidi: 64, reward: [{ midi: 60 }] }, scoring: { max: 10 } },
    { id: 'q2', data: { answerMidi: 71 }, scoring: { max: 10 } },
  ]
  return {
    schemaVersion: 1,
    kind: 'level',
    id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A1',
    version: '1.0.0',
    meta: { title: '测试关卡' },
    content: {
      components: [
        { id: 'staff1', type: 'staff', bindings: { music: '$q.data.music' } },
        { id: 'sound1', type: 'sound', visible: false },
        { id: 'choice1', type: 'choice', bindings: { options: '$q.data.options' } },
      ],
      logic: {
        variables: overrides?.variables ?? { score: 0, done: false },
        rules: overrides?.rules ?? [
          {
            id: 'check',
            on: 'staff1.noteClicked',
            when: ['event.midi == q.data.answerMidi'],
            do: [{ set: 'score', expr: 'v.score + q.scoring.max' }],
            else: [{ set: 'score', expr: 'v.score - 1' }],
          },
          { id: 'next', on: 'nextBtn.clicked', do: [{ cmd: 'level.next' }] },
        ],
      },
      questions,
      flow: { order: 'sequential', pass: overrides?.pass ? { expr: overrides.pass } : undefined },
    },
  }
}

interface Recording {
  questions: { index: number; total: number; id: string | null }[]
  finished: { score: Json; passed: boolean }[]
  effects: unknown[]
}

function makeHost(): { host: SessionHost; rec: Recording } {
  const rec: Recording = { questions: [], finished: [], effects: [] }
  const host: SessionHost = {
    onQuestion: (index, total, q) => rec.questions.push({ index, total, id: q?.id ?? null }),
    onFinished: (result) => rec.finished.push(result),
    runEffects: (effects) => rec.effects.push(...effects),
  }
  return { host, rec }
}

describe('LevelSession', () => {
  it('start 触发 started→装载第 1 题→questionLoaded，绑定解析到组件', () => {
    const doc = makeDoc()
    const q1data = doc.content.questions[0].data as Record<string, Json>
    q1data.music = { notes: [{ midi: 60 }] }
    q1data.options = ['A', 'B']
    const { host, rec } = makeHost()
    const session = new LevelSession(doc, host)
    session.start()

    expect(rec.questions[0]).toEqual({ index: 0, total: 2, id: 'q1' })
    expect(session.store.snapshot('staff1').state).toMatchObject({ music: { notes: [{ midi: 60 }] } })
    expect(session.store.snapshot('choice1').state).toMatchObject({ options: ['A', 'B'] })
  })

  it('判定规则：对错分支与计分', () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc(), host)
    session.start()

    session.dispatch('staff1.noteClicked', { midi: 60 }) // 错
    expect(session.engine.vars.score).toBe(-1)
    session.dispatch('staff1.noteClicked', { midi: 64 }) // 对
    expect(session.engine.vars.score).toBe(9)

    session.dispatch('nextBtn.clicked')
    expect(rec.questions.at(-1)).toMatchObject({ index: 1, id: 'q2' })
  })

  it('最后一题 next → 结算（flow.pass 求值）', () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc({ pass: 'v.score >= 20' }), host)
    session.start()
    session.dispatch('staff1.noteClicked', { midi: 64 })
    session.dispatch('nextBtn.clicked')
    session.dispatch('staff1.noteClicked', { midi: 71 })
    session.dispatch('nextBtn.clicked')

    expect(rec.finished).toEqual([{ score: 20, passed: true }])
  })

  it('finish 幂等：on level.finished 规则再发 level.next 不会无限递归/重复结算', () => {
    const rules: LevelDoc['content']['logic']['rules'] = [
      { id: 'next', on: 'nextBtn.clicked', do: [{ cmd: 'level.next' }] },
      // UGC 作者常见误写：结束后想自动进入下一关
      { id: 'again', on: 'level.finished', do: [{ cmd: 'level.next' }] },
    ]
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc({ rules }), host)
    session.start()
    session.dispatch('nextBtn.clicked')
    session.dispatch('nextBtn.clicked')

    expect(rec.finished).toHaveLength(1)
  })

  it('flow.pass 表达式抛错时降级为未通过，不中断结算', () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc({ pass: 'v.score / 0 > 1' }), host)
    session.start()
    session.dispatch('nextBtn.clicked')
    session.dispatch('nextBtn.clicked')
    // 除零抛 ExprError → passed=false，但结算照常完成
    expect(rec.finished).toHaveLength(1)
    expect(rec.finished[0].passed).toBe(false)
  })

  it('logicPatch：variables 覆盖 + appendRules 仅本题生效', () => {
    const questions: Question[] = [
      { id: 'q1', data: {}, scoring: { max: 10 } },
      {
        id: 'q2',
        data: {},
        scoring: { max: 10 },
        logicPatch: {
          variables: { score: 50 },
          appendRules: [{ id: 'p1', on: 'x.ping', do: [{ set: 'score', expr: 'v.score + 1' }] }],
        },
      },
      { id: 'q3', data: {}, scoring: { max: 10 } },
    ]
    const { host } = makeHost()
    const session = new LevelSession(makeDoc({ questions }), host)
    session.start()

    session.dispatch('x.ping') // q1：无此规则
    expect(session.engine.vars.score).toBe(0)

    session.dispatch('nextBtn.clicked')
    expect(session.currentQuestion?.id).toBe('q2')
    expect(session.engine.vars.score).toBe(50) // variables 已覆盖
    session.dispatch('x.ping')
    expect(session.engine.vars.score).toBe(51) // appendRules 生效

    session.dispatch('nextBtn.clicked')
    expect(session.currentQuestion?.id).toBe('q3')
    session.dispatch('x.ping')
    expect(session.engine.vars.score).toBe(51) // 换题后追加规则已移除
  })

  it('restart 重置变量与组件状态并重新装载', () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc(), host)
    session.start()
    session.dispatch('staff1.noteClicked', { midi: 64 })
    session.dispatch('nextBtn.clicked')
    session.restart()

    expect(session.engine.vars.score).toBe(0)
    expect(session.currentQuestion?.id).toBe('q1')
    expect(rec.questions.at(-1)).toMatchObject({ index: 0, id: 'q1' })
  })

  it('shuffle + count 抽题', () => {
    const questions: Question[] = [1, 2, 3, 4, 5].map((i) => ({
      id: `q${i}`,
      data: { n: i },
      scoring: { max: 1 },
    }))
    const doc = makeDoc({ questions })
    doc.content.flow = { order: 'shuffle', count: 3 }
    const { host, rec } = makeHost()
    const session = new LevelSession(doc, host)
    session.start()
    expect(session.total).toBe(3)
    const seen = new Set<string>()
    for (let i = 0; i < 3; i++) {
      expect(session.currentQuestion?.id).toMatch(/^q[1-5]$/)
      seen.add(session.currentQuestion!.id)
      session.dispatch('nextBtn.clicked')
    }
    expect(seen.size).toBe(3)
    expect(rec.finished).toHaveLength(1) // 抽完后结束
  })

  it('timer：单次 tick 派发事件；stop 取消不再触发', async () => {
    vi.useFakeTimers()
    try {
      const rules: LevelDoc['content']['logic']['rules'] = [
        { id: 'arm', on: 'level.questionLoaded', do: [{ cmd: 'timer1.start', args: { ms: 50 } }] },
        { id: 'onTick', on: 'timer1.tick', when: ['event.count == 1'], do: [{ set: 'fired', expr: 'true' }] },
        { id: 'stop', on: 'x.stop', do: [{ cmd: 'timer1.stop' }] },
      ]
      const doc = makeDoc({ rules, variables: { score: 0, done: false, fired: false } })
      doc.content.components.push({ id: 'timer1', type: 'timer', visible: false })
      const { host } = makeHost()
      const session = new LevelSession(doc, host)
      session.start()
      expect(session.engine.vars.fired).toBe(false)

      vi.advanceTimersByTime(80)
      expect(session.engine.vars.fired).toBe(true)

      // restart 会重置变量并重新 arm；随后立即 stop，tick 不应再发生
      session.restart()
      expect(session.engine.vars.fired).toBe(false)
      session.dispatch('x.stop')
      vi.advanceTimersByTime(300)
      expect(session.engine.vars.fired).toBe(false)
      expect(session.store.snapshot('timer1').state).toMatchObject({ running: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('timer：repeat 模式多次 tick，dispose 后不再触发', async () => {
    vi.useFakeTimers()
    try {
      const rules: LevelDoc['content']['logic']['rules'] = [
        { id: 'arm', on: 'level.questionLoaded', do: [{ cmd: 'timer1.start', args: { ms: 40, repeat: true } }] },
        { id: 'onTick', on: 'timer1.tick', do: [{ set: 'ticks', expr: 'v.ticks + 1' }] },
      ]
      const doc = makeDoc({ rules, variables: { score: 0, done: false, ticks: 0 } })
      doc.content.components.push({ id: 'timer1', type: 'timer', visible: false })
      const { host } = makeHost()
      const session = new LevelSession(doc, host)
      session.start()
      vi.advanceTimersByTime(150)
      const ticks = session.engine.vars.ticks as number
      expect(ticks).toBeGreaterThanOrEqual(2)

      session.dispose()
      vi.advanceTimersByTime(200)
      expect(session.engine.vars.ticks).toBe(ticks) // 不再增长
    } finally {
      vi.useRealTimers()
    }
  })

  it('未知组件引用被 lint 捕获（console.warn 不抛错）', () => {
    const rules: LevelDoc['content']['logic']['rules'] = [
      { id: 'bad', on: 'ghost.noteClicked', do: [{ cmd: 'ghost.clear' }] },
    ]
    const { host } = makeHost()
    const warn = console.warn
    const calls: unknown[] = []
    console.warn = (...args: unknown[]) => calls.push(args)
    try {
      expect(() => new LevelSession(makeDoc({ rules }), host)).not.toThrow()
    } finally {
      console.warn = warn
    }
  })
})
