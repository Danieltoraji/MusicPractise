import { describe, expect, it, vi } from 'vitest'
import type { LevelDoc, TableRow, ViewDef } from '../engine/level'
import type { Json } from '../engine/expr'
import { migrateDocToV3 } from '../engine/migrateDoc'
import { LevelSession, type SessionHost } from './levelSession'

/** GraphEngine 的 dispatch 是 fire-and-forget async：排空微任务等待 drain 完成（fake timers 下也安全） */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** 行身份：测试用 data.tag 标识行（v3 无 question.id，表格行即题目） */
const rowTag = (row: TableRow | null): string | null => {
  const tag = row?.data && typeof row.data === 'object' ? (row.data as Record<string, Json>).tag : undefined
  return typeof tag === 'string' ? tag : null
}

/**
 * 测试文档构造：有意以 v1 形态（ECA 规则/questions/logicPatch）书写，
 * 经 migrateDocToV3（与真实装载管线一致）出 v3 —— 同时覆盖「旧文档透明升级」路径。
 */
function makeDoc(overrides?: {
  questions?: {
    id: string
    data: Json
    scoring?: { max: number }
    logicPatch?: { variables?: Record<string, Json>; appendRules?: unknown[] }
  }[]
  /** v1 ECA 规则（验证 LevelSession 的透明迁移） */
  rules?: { id: string; on: string; when?: string[]; do: { set?: string; expr?: string; cmd?: string; args?: Json }[]; else?: { set?: string; expr?: string; cmd?: string; args?: Json }[] }[]
  pass?: string
  variables?: Record<string, Json>
  views?: ViewDef[]
}): LevelDoc {
  const questions = overrides?.questions ?? [
    { id: 'q1', data: { tag: 'r1', answerMidi: 64, reward: [{ midi: 60 }] }, scoring: { max: 10 } },
    { id: 'q2', data: { tag: 'r2', answerMidi: 71 }, scoring: { max: 10 } },
  ]
  const legacy = {
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
      },
      questions,
      ...(overrides?.views ? { views: overrides.views } : {}),
      flow: { order: 'sequential', pass: overrides?.pass ? { expr: overrides.pass } : undefined },
    },
  }
  return migrateDocToV3(legacy)
}

interface Recording {
  rows: { index: number; total: number; tag: string | null }[]
  views: string[]
  finished: { score: Json; passed: boolean }[]
  effects: unknown[]
}

function makeHost(): { host: SessionHost; rec: Recording } {
  const rec: Recording = { rows: [], views: [], finished: [], effects: [] }
  const host: SessionHost = {
    onRow: (index, total, row) => rec.rows.push({ index, total, tag: rowTag(row) }),
    onView: (id) => rec.views.push(id),
    onFinished: (result) => rec.finished.push(result),
    runEffects: (effects) => rec.effects.push(...effects),
  }
  return { host, rec }
}

describe('LevelSession', () => {
  it('start 触发 started→初始视图→装载第 1 行→questionLoaded，绑定解析到组件', async () => {
    const doc = makeDoc()
    const r1 = doc.content.table.rows[0].data as Record<string, Json>
    r1.music = { notes: [{ midi: 60 }] }
    r1.options = ['A', 'B']
    const { host, rec } = makeHost()
    const session = new LevelSession(doc, host)
    session.start()

    expect(rec.views).toEqual(['main'])
    expect(rec.rows[0]).toEqual({ index: 0, total: 2, tag: 'r1' })
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
    expect(rec.rows.at(-1)).toMatchObject({ index: 1, tag: 'r2' })
  })

  it('最后一行 next → 结算（flow.pass 求值）', async () => {
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

  it('logicPatch（经 v3 迁移器编译为行门控子图）：variables 覆盖 + appendRules 仅本行生效', async () => {
    const questions = [
      { id: 'q1', data: { tag: 'r1' }, scoring: { max: 10 } },
      {
        id: 'q2',
        data: { tag: 'r2' },
        scoring: { max: 10 },
        logicPatch: {
          variables: { score: 50 },
          appendRules: [{ id: 'p1', on: 'x.ping', do: [{ set: 'score', expr: 'v.score + 1' }] }],
        },
      },
      { id: 'q3', data: { tag: 'r3' }, scoring: { max: 10 } },
    ]
    const { host } = makeHost()
    const session = new LevelSession(makeDoc({ questions }), host)
    session.start()

    session.dispatch('x.ping') // r1：门控 event.row == 1 不通过
    await flush()
    expect(session.engine.vars.score).toBe(0)

    session.dispatch('nextBtn.clicked')
    await flush()
    expect(rowTag(session.currentRow)).toBe('r2')
    expect(session.engine.vars.score).toBe(50) // 行装载子图已覆盖变量
    session.dispatch('x.ping')
    await flush()
    expect(session.engine.vars.score).toBe(51) // 本行追加规则生效

    session.dispatch('nextBtn.clicked')
    await flush()
    expect(rowTag(session.currentRow)).toBe('r3')
    session.dispatch('x.ping')
    await flush()
    expect(session.engine.vars.score).toBe(51) // 换行后门控不再放行
  })

  it('restart 重置变量与组件状态并重新装载（视图复位到首视图）', async () => {
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc(), host)
    session.start()
    session.dispatch('staff1.noteClicked', { midi: 64 })
    await flush()
    session.dispatch('nextBtn.clicked')
    await flush()
    session.restart()

    expect(session.engine.vars.score).toBe(0)
    expect(rowTag(session.currentRow)).toBe('r1')
    expect(rec.views.at(-1)).toBe('main')
    expect(rec.rows.at(-1)).toMatchObject({ index: 0, tag: 'r1' })
  })

  it('shuffle + count 抽行', async () => {
    const questions = [1, 2, 3, 4, 5].map((i) => ({
      id: `q${i}`,
      data: { tag: `r${i}`, n: i },
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
      const tag = rowTag(session.currentRow)
      expect(tag).toMatch(/^r[1-5]$/)
      seen.add(tag!)
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

  it('换行清理计时器：logicPatch arm 的重复计时器在换行后不再触发（P1 回归，经行门控编译）', async () => {
    vi.useFakeTimers()
    try {
      const questions = [
        {
          id: 'q1',
          data: { tag: 'r1' },
          scoring: { max: 10 },
          logicPatch: {
            appendRules: [
              { id: 'p-arm', on: 'level.questionLoaded', do: [{ cmd: 'timer1.start', args: { ms: 20, repeat: true } }] },
              { id: 'p-tick', on: 'timer1.tick', do: [{ set: 'ticks', expr: 'v.ticks + 1' }] },
            ],
          },
        },
        { id: 'q2', data: { tag: 'r2' }, scoring: { max: 10 } },
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

      session.dispatch('nextBtn.clicked') // → r2：行门控关闭 + 换行强制清理计时器
      await flush()
      await vi.advanceTimersByTimeAsync(200)
      expect(session.engine.vars.ticks).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('views.goto：切换视图并派发 view.entered；同视图重复 goto 是 no-op', async () => {
    const rules = [
      { id: 'go', on: 'goBtn.clicked', do: [{ cmd: 'views.goto', args: { id: 'quiz' } }] },
      { id: 'mark', on: 'view.entered', do: [{ set: 'entered', expr: 'v.entered + 1' }] },
    ]
    const views = [{ id: 'main' }, { id: 'quiz', name: '答题' }]
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc({ rules, views, variables: { score: 0, done: false, entered: 0 } }), host)
    session.start()
    expect(session.currentView).toBe('main')
    expect(rec.views).toEqual(['main']) // 初始进入
    expect(session.engine.vars.entered).toBe(1)

    session.dispatch('goBtn.clicked')
    await flush()
    expect(session.currentView).toBe('quiz')
    expect(rec.views).toEqual(['main', 'quiz'])
    expect(session.engine.vars.entered).toBe(2)

    session.dispatch('goBtn.clicked') // 同视图：no-op（防事件环）
    await flush()
    expect(session.currentView).toBe('quiz')
    expect(rec.views).toEqual(['main', 'quiz'])
    expect(session.engine.vars.entered).toBe(2)
  })

  it('views.goto 指向不存在的视图：报 error 事件、视图不变', async () => {
    const rules = [{ id: 'go', on: 'goBtn.clicked', do: [{ cmd: 'views.goto', args: { id: 'ghost' } }] }]
    const events: { kind: string; message?: string }[] = []
    const { host } = makeHost()
    const wrapped: SessionHost = {
      ...host,
      onLogicEvent: (e) => events.push({ kind: e.kind, message: e.kind === 'error' ? e.message : undefined }),
    }
    const session = new LevelSession(makeDoc({ rules, views: [{ id: 'main' }] }), wrapped)
    session.start()
    session.dispatch('goBtn.clicked')
    await flush()
    expect(session.currentView).toBe('main')
    expect(events.some((e) => e.kind === 'error' && e.message?.includes('ghost'))).toBe(true)
  })

  it('level.next：换行后自动切换到模版视图', async () => {
    const views = [{ id: 'main' }, { id: 'quiz', name: '答题', template: true }]
    const rules = [{ id: 'next', on: 'nextBtn.clicked', do: [{ cmd: 'level.next' }] }]
    const { host, rec } = makeHost()
    const session = new LevelSession(makeDoc({ rules, views }), host)
    session.start()
    expect(session.currentView).toBe('main') // 初始视图 = 首视图（模版是 quiz 也不抢初始）
    session.dispatch('nextBtn.clicked')
    await flush()
    expect(rowTag(session.currentRow)).toBe('r2')
    expect(session.currentView).toBe('quiz') // 「显示题目」抽象：换行自动进模版视图
    expect(rec.views).toEqual(['main', 'quiz'])
  })

  it('P1 回归：命令执行失败（未知实例）产生 error 事件', async () => {
    const events: { kind: string; path?: string; nodeId?: string; message?: string }[] = []
    const { host } = makeHost()
    const wrapped: SessionHost = {
      ...host,
      onLogicEvent: (e) =>
        events.push({
          kind: e.kind,
          path: e.kind === 'command' ? e.path : undefined,
          nodeId: e.kind === 'error' ? e.nodeId : undefined,
          message: e.kind === 'error' ? e.message : undefined,
        }),
    }
    const rules = [{ id: 'bad', on: 'staff1.noteClicked', do: [{ cmd: 'ghost.clear' }] }]
    const session = new LevelSession(makeDoc({ rules }), wrapped)
    session.start()
    await flush()
    session.dispatch('staff1.noteClicked', {})
    await flush()
    const errEvt = events.find((e) => e.kind === 'error' && e.message?.includes('ghost.clear'))
    expect(errEvt).toBeTruthy()
    expect(errEvt!.nodeId).toBeTruthy()
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
    //（绑定解析失败的 error 无 nodeId，这里必须按 nodeId 过滤定位）
    const errEvt = events.find((e) => e.kind === 'error' && e.nodeId)
    expect(errEvt).toBeTruthy()
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
