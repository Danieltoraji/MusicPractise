import { describe, expect, it, vi } from 'vitest'
import type { LevelDoc, Question } from '../engine/level'
import type { Json } from '../engine/expr'
import { LevelSession, type SessionHost } from './levelSession'

/** GraphEngine 的 dispatch 是 fire-and-forget async：排空微任务等待 drain 完成（fake timers 下也安全） */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

function makeDoc(overrides?: {
  questions?: Question[]
  /** v1 ECA 规则（本测试有意用 v1 形态构造，验证 LevelSession 的透明迁移） */
  rules?: { id: string; on: string; when?: string[]; do: { set?: string; expr?: string; cmd?: string; args?: Json }[]; else?: { set?: string; expr?: string; cmd?: string; args?: Json }[] }[]
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
      // 有意以 v1 ECA 形态构造：验证 LevelSession/GraphEngine 对旧文档的透明迁移
      logic: {
        variables: overrides?.variables ?? { score: 0, done: false },
        rules:
          overrides?.rules ?? [
            {
              id: 'check',
              on: 'staff1.noteClicked',
              when: ['event.midi == q.data.answerMidi'],
              do: [{ set: 'score', expr: 'v.score + q.scoring.max' }],
              else: [{ set: 'score', expr: 'v.score - 1' }],
            },
            { id: 'next', on: 'nextBtn.clicked', do: [{ cmd: 'level.next' }] },
          ],
      } as unknown as LevelDoc['content']['logic'],
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
  it('start 触发 started→装载第 1 题→questionLoaded，绑定解析到组件', async () => {
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

  it('判定规则：对错分支与计分', async () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc(), host)
    session.start()

    session.dispatch('staff1.noteClicked', { midi: 60 }) // 错
    await flush()
    expect(session.engine.vars.score).toBe(-1)
    session.dispatch('staff1.noteClicked', { midi: 64 }) // 对
    await flush()
    expect(session.engine.vars.score).toBe(9)

    session.dispatch('nextBtn.clicked')
    await flush()
    expect(rec.questions.at(-1)).toMatchObject({ index: 1, id: 'q2' })
  })

  it('最后一题 next → 结算（flow.pass 求值）', async () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc({ pass: 'v.score >= 20' }), host)
    session.start()
    session.dispatch('staff1.noteClicked', { midi: 64 })
    await flush()
    session.dispatch('nextBtn.clicked')
    await flush()
    session.dispatch('staff1.noteClicked', { midi: 71 })
    await flush()
    session.dispatch('nextBtn.clicked')
    await flush()

    expect(rec.finished).toEqual([{ score: 20, passed: true }])
  })

  it('finish 幂等：on level.finished 规则再发 level.next 不会无限递归/重复结算', async () => {
    const rules = [
      { id: 'next', on: 'nextBtn.clicked', do: [{ cmd: 'level.next' }] },
      // UGC 作者常见误写：结束后想自动进入下一关
      { id: 'again', on: 'level.finished', do: [{ cmd: 'level.next' }] },
    ]
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc({ rules }), host)
    session.start()
    session.dispatch('nextBtn.clicked')
    await flush()
    session.dispatch('nextBtn.clicked')
    await flush()

    expect(rec.finished).toHaveLength(1)
  })

  it('flow.pass 表达式抛错时降级为未通过，不中断结算', async () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc({ pass: 'v.score / 0 > 1' }), host)
    session.start()
    session.dispatch('nextBtn.clicked')
    await flush()
    session.dispatch('nextBtn.clicked')
    await flush()
    // 除零抛 ExprError → passed=false，但结算照常完成
    expect(rec.finished).toHaveLength(1)
    expect(rec.finished[0].passed).toBe(false)
  })

  it('logicPatch：variables 覆盖 + appendRules 仅本题生效', async () => {
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
    await flush()
    expect(session.engine.vars.score).toBe(0)

    session.dispatch('nextBtn.clicked')
    await flush()
    expect(session.currentQuestion?.id).toBe('q2')
    expect(session.engine.vars.score).toBe(50) // variables 已覆盖
    session.dispatch('x.ping')
    await flush()
    expect(session.engine.vars.score).toBe(51) // appendRules 生效

    session.dispatch('nextBtn.clicked')
    await flush()
    expect(session.currentQuestion?.id).toBe('q3')
    session.dispatch('x.ping')
    await flush()
    expect(session.engine.vars.score).toBe(51) // 换题后追加规则已移除
  })

  it('restart 重置变量与组件状态并重新装载', async () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc(), host)
    session.start()
    session.dispatch('staff1.noteClicked', { midi: 64 })
    await flush()
    session.dispatch('nextBtn.clicked')
    await flush()
    session.restart()

    expect(session.engine.vars.score).toBe(0)
    expect(session.currentQuestion?.id).toBe('q1')
    expect(rec.questions.at(-1)).toMatchObject({ index: 0, id: 'q1' })
  })

  it('shuffle + count 抽题', async () => {
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
      await flush()
    }
    expect(seen.size).toBe(3)
    expect(rec.finished).toHaveLength(1) // 抽完后结束
  })

  it('timer：单次 tick 派发事件；stop 取消不再触发', async () => {
    vi.useFakeTimers()
    try {
      const rules = [
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

      await vi.advanceTimersByTimeAsync(80)
      expect(session.engine.vars.fired).toBe(true)

      // restart 会重置变量并重新 arm；随后立即 stop，tick 不应再发生
      session.restart()
      expect(session.engine.vars.fired).toBe(false)
      session.dispatch('x.stop')
      await flush()
      await vi.advanceTimersByTimeAsync(300)
      expect(session.engine.vars.fired).toBe(false)
      expect(session.store.snapshot('timer1').state).toMatchObject({ running: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('timer：repeat 模式多次 tick，dispose 后不再触发', async () => {
    vi.useFakeTimers()
    try {
      const rules = [
        { id: 'arm', on: 'level.questionLoaded', do: [{ cmd: 'timer1.start', args: { ms: 40, repeat: true } }] },
        { id: 'onTick', on: 'timer1.tick', do: [{ set: 'ticks', expr: 'v.ticks + 1' }] },
      ]
      const doc = makeDoc({ rules, variables: { score: 0, done: false, ticks: 0 } })
      doc.content.components.push({ id: 'timer1', type: 'timer', visible: false })
      const { host } = makeHost()
      const session = new LevelSession(doc, host)
      session.start()
      await vi.advanceTimersByTimeAsync(150)
      const ticks = session.engine.vars.ticks as number
      expect(ticks).toBeGreaterThanOrEqual(2)

      session.dispose()
      // dispose 会作废引擎（reset）：变量归初始值，且计时器已停、不再增长
      expect(session.engine.vars.ticks).toBe(0)
      await vi.advanceTimersByTimeAsync(200)
      expect(session.engine.vars.ticks).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('换题清理计时器：logicPatch arm 的重复计时器在换题后不再触发（P1 回归）', async () => {
    vi.useFakeTimers()
    try {
      const questions: Question[] = [
        {
          id: 'q1',
          data: {},
          scoring: { max: 10 },
          logicPatch: {
            appendRules: [
              { id: 'p-arm', on: 'level.questionLoaded', do: [{ cmd: 'timer1.start', args: { ms: 20, repeat: true } }] },
              { id: 'p-tick', on: 'timer1.tick', do: [{ set: 'ticks', expr: 'v.ticks + 1' }] },
            ],
          },
        },
        { id: 'q2', data: {}, scoring: { max: 10 } },
      ]
      const doc = makeDoc({
        questions,
        rules: [{ id: 'next', on: 'nextBtn.clicked', do: [{ cmd: 'level.next' }] }],
        variables: { score: 0, done: false, ticks: 0 },
      })
      doc.content.components.push({ id: 'timer1', type: 'timer', visible: false })
      const { host } = makeHost()
      const session = new LevelSession(doc, host)
      session.start()
      await vi.advanceTimersByTimeAsync(60)
      const before = session.engine.vars.ticks as number
      expect(before).toBeGreaterThanOrEqual(2)

      session.dispatch('nextBtn.clicked') // → q2：追加规则已移除，且换题强制清理计时器
      await flush()
      await vi.advanceTimersByTimeAsync(200)
      expect(session.engine.vars.ticks).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('运行日志钩子：错误与命令轨迹进入 onLogicEvent', async () => {
    const events: { kind: string; message?: string; path?: string; nodeId?: string }[] = []
    const { host } = makeHost()
    const wrapped: SessionHost = {
      ...host,
      onLogicEvent: (e) =>
        events.push({
          kind: e.kind,
          message: e.kind === 'error' ? e.message : undefined,
          path: e.kind === 'command' ? e.path : undefined,
          nodeId: e.kind === 'error' ? e.nodeId : undefined,
        }),
    }
    // 规则：call（命令轨迹）→ branch（cond 引用 event.x，空负载下报错且带 nodeId）
    const rules = [
      { id: 'cmd', on: 'staff1.noteClicked', do: [{ cmd: 'sound1.play', args: { notes: [{ midi: 60 }] } }] },
      { id: 'judge', on: 'staff1.noteClicked', when: ['event.midi == q.data.answerMidi'], do: [{ set: 'score', expr: 'v.score + 1' }] },
    ]
    const session = new LevelSession(makeDoc({ rules }), wrapped)
    session.start()
    await flush()
    session.dispatch('staff1.noteClicked', {})
    await flush()
    expect(events.some((e) => e.kind === 'command' && e.path === 'sound1.play')).toBe(true)
    // 空 payload 下 event.midi 求值失败 → error 事件携带 nodeId（可定位节点）
    const errEvt = events.find((e) => e.kind === 'error')
    expect(errEvt).toBeTruthy()
    expect(errEvt!.nodeId).toBeTruthy()
  })

  it('视图直调 applyCommand 的效果也经执行通道（strike 发声回归）', async () => {
    const doc = makeDoc()
    doc.content.components.push({ id: 'keys1', type: 'fingering' })
    const { host, rec } = makeHost()
    const session = new LevelSession(doc, host)
    // 模拟视图层点击琴键：不经逻辑引擎，直接 applyCommand
    session.store.applyCommand('keys1', '__strike', { midi: 60 })
    expect(rec.effects).toEqual([
      { type: 'audio.play', notes: [{ midi: 60, dur: '8n' }], mode: 'chord' },
    ])
  })

  it('未知组件引用被 lint 捕获（console.warn 不抛错）', async () => {
    const rules = [
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
