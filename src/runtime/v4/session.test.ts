import { afterEach, describe, expect, it, vi } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type {
  BehaviorNode,
  BehaviorProgram,
  FlowNode,
  GraphEdge,
  LevelDocV4,
  RunResult,
} from '../../engine/v4/model'
import type { V4RunEvent } from './session'
import { V4Session, type TimerApi, type V4SessionHost } from './session'

interface Harness {
  finished: RunResult[]
  effects: { type: string; layer: string; componentId: string }[]
  events: V4RunEvent[]
  host: V4SessionHost
}

function makeHost(overrides: Partial<V4SessionHost> = {}): Harness {
  const finished: RunResult[] = []
  const effects: { type: string; layer: string; componentId: string }[] = []
  const events: V4RunEvent[] = []
  const host: V4SessionHost = {
    onFinished(result) {
      finished.push(result)
    },
    runEffects(list, origin) {
      for (const effect of list) effects.push({ type: effect.type, layer: origin.layer, componentId: origin.componentId })
    },
    onRunEvent(event) {
      events.push(event)
    },
    ...overrides,
  }
  return { finished, effects, events, host }
}

function flowProgram(nodes: FlowNode[], edges: GraphEdge[]): LevelDocV4['content']['flow'] {
  return {
    logicVersion: 3,
    kind: 'flow',
    nodes,
    edges,
    vars: [{ key: 'score', type: 'number', init: 0 }],
  }
}

function out(from: string, to: string, port?: 'true' | 'false'): GraphEdge {
  return { id: `e_${from}_${to}_${port ?? 'out'}`, from, to, ...(port ? { port } : {}) }
}

function behavior(nodes: BehaviorNode[], edges: GraphEdge[]): BehaviorProgram {
  return { logicVersion: 3, kind: 'behavior', nodes, edges }
}

/** 顺序遍历题单 + 应用 scoreDelta + 结算（最常用流程） */
function askAllFlow(): LevelDocV4['content']['flow'] {
  return flowProgram(
    [
      { id: 'f_start', kind: 'start' },
      { id: 'f_foreach', kind: 'foreach', items: 'run.questions', itemVar: 'slot' },
      { id: 'f_ask', kind: 'ask', target: 'local.slot', resultVar: 'result' },
      { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'v.score + local.result.scoreDelta' } },
      { id: 'f_finish', kind: 'finish', passed: 'v.score >= 20' },
    ],
    [
      out('f_start', 'f_foreach'),
      out('f_foreach', 'f_ask', 'true'),
      out('f_foreach', 'f_finish', 'false'),
      out('f_ask', 'f_apply'),
      out('f_apply', 'f_foreach'),
    ],
  )
}

function docWith(behaviorProgram: BehaviorProgram, flow = askAllFlow()): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.types[0].behavior = behaviorProgram
  doc.content.flow = flow
  return doc
}

/** 立即返回正确结果（scoreDelta = q.scoring） */
function instantCorrect(): BehaviorProgram {
  return behavior(
    [
      { id: 'b_start', kind: 'on', event: 'start' },
      { id: 'b_ret', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }" },
    ],
    [out('b_start', 'b_ret')],
  )
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`等待超时：${label}`)
}

const sessions: V4Session[] = []
function track(session: V4Session): V4Session {
  sessions.push(session)
  return session
}

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose()
  vi.useRealTimers()
})

describe('v4 session：启动 / ask / 结算', () => {
  it('自动题单 2 行 → 逐题 ask（行为立即返回）→ score/passed 结算 + 进度', async () => {
    const h = makeHost()
    const session = track(new V4Session(docWith(instantCorrect()), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().result !== null, '结算')
    expect(h.finished).toEqual([{ score: 20, passed: true }])
    const snapshot = session.getSnapshot()
    expect(snapshot.progress).toEqual({ index: 2, total: 2 })
    expect(snapshot.result).toEqual({ score: 20, passed: true })
    expect(snapshot.surface).toBeNull()
    expect(session.deck.map((item) => item.row)).toEqual(['row_01', 'row_02'])
    expect(typeof session.seed).toBe('number')
  })

  it('shell 绑定随 v.score 变化下发命令（label.setText）', async () => {
    const h = makeHost()
    const session = track(new V4Session(docWith(instantCorrect()), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().result !== null, '结算')
    const label = session.shellStore.snapshot('scoreLabel')
    expect((label.state as { text?: string }).text).toBe('得分: 20')
  })

  it('surface 选择/谱面绑定初值经命令生效（choice.options / staff.music）', async () => {
    const doc = docWith(waitThenReturnByEventFixture(), flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_finish', kind: 'finish', passed: 'true' },
      ],
      [out('f_start', 'f_ask'), out('f_ask', 'f_finish')],
    ))
    // 在 fixture 表上增加谱面数据列，并给 surface 加 staff 组件（绑定 music → q.staffMusic）
    doc.content.tables.choice.columns.push({ key: 'staffMusic', label: '谱面', type: 'json' })
    doc.content.tables.choice.rows[0].staffMusic = { notes: [{ midi: 64 }], clef: 'treble' }
    doc.content.types[0].surface.components.push({
      id: 'staff1',
      type: 'staff',
      layout: { x: 20, y: 340, w: 400, h: 110 },
      bindings: { music: 'q.staffMusic' },
    })
    const h = makeHost()
    const session = track(new V4Session(doc, h.host))
    session.start()
    await waitFor(() => session.getSnapshot().surface !== null, '挂载 surface')
    const store = session.getSurfaceStore()!
    const choice = store.snapshot('choice1').state as { options: string[] }
    expect(choice.options).toEqual(['Do', 'Re', 'Mi'])
    const staff = store.snapshot('staff1').state as { music: { notes: { midi: number }[] } | null }
    expect(staff.music?.notes?.[0]?.midi).toBe(64)
    session.dispatchSurfaceEvent('choice1', 'chosen', { score: 1 })
    await waitFor(() => session.getSnapshot().result !== null, '结算')
  })

  it('behavior.locals 声明在调用开始时按初值初始化（docs/53 §7）', async () => {
    const behaviorWithLocals: BehaviorProgram = {
      logicVersion: 3,
      kind: 'behavior',
      nodes: [
        { id: 'b_start', kind: 'on', event: 'start' },
        {
          id: 'b_ret',
          kind: 'return',
          result: "{ status: 'answered', scoreDelta: len(local.acc) }",
        },
      ],
      edges: [out('b_start', 'b_ret')],
      locals: [{ key: 'acc', type: 'json', init: [1, 2, 3] }],
    }
    const flow = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'local.r.scoreDelta' } },
        { id: 'f_finish', kind: 'finish', passed: 'true' },
      ],
      [out('f_start', 'f_ask'), out('f_ask', 'f_apply'), out('f_apply', 'f_finish')],
    )
    const h = makeHost()
    const session = track(new V4Session(docWith(behaviorWithLocals, flow), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().result !== null, '结算')
    expect(h.finished).toEqual([{ score: 3, passed: true }])
  })

  it('finish 后 flow 继续 waitShell；shell 事件唤醒后流程自然结束', async () => {
    const flow = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'local.r.scoreDelta' } },
        { id: 'f_finish', kind: 'finish', passed: 'v.score >= 10' },
        { id: 'f_wait', kind: 'waitShell', event: 'scoreLabel.clicked' },
      ],
      [
        out('f_start', 'f_ask'),
        out('f_ask', 'f_apply'),
        out('f_apply', 'f_finish'),
        out('f_finish', 'f_wait'),
      ],
    )
    const h = makeHost()
    const session = track(new V4Session(docWith(instantCorrect(), flow), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().result !== null, '结算')
    expect(h.finished).toHaveLength(1)
    // 结算后流程仍在等待 shell 事件（running 仍为 true）
    expect(session.getSnapshot().running).toBe(true)
    session.dispatchShellEvent('scoreLabel', 'clicked')
    await waitFor(() => session.getSnapshot().running === false, '流程结束')
    expect(session.getSnapshot().result).toEqual({ score: 10, passed: true })
  })

  it('restart：清空结果、重新发牌、再次结算', async () => {
    const h = makeHost()
    const session = track(new V4Session(docWith(instantCorrect()), h.host))
    session.start()
    await waitFor(() => h.finished.length === 1, '首次结算')
    session.restart()
    await waitFor(() => h.finished.length === 2, '重开后结算')
    expect(h.finished[1]).toEqual({ score: 20, passed: true })
    expect(session.getSnapshot().progress).toEqual({ index: 2, total: 2 })
  })
})

describe('v4 session：surface 帧与事件路由', () => {
  function waitThenReturnByEvent(): BehaviorProgram {
    return behavior(
      [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_on', kind: 'on', event: 'choice1.chosen' },
        { id: 'b_ret', kind: 'return', result: "{ scoreDelta: event.payload.score }" },
      ],
      [out('b_on', 'b_ret')],
    )
  }

  it('ask 挂载 surface（快照可见）→ 注入组件事件 → return 后卸载', async () => {
    const flow = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'local.r.scoreDelta' } },
        { id: 'f_finish', kind: 'finish', passed: 'v.score >= 5' },
      ],
      [out('f_start', 'f_ask'), out('f_ask', 'f_apply'), out('f_apply', 'f_finish')],
    )
    const h = makeHost()
    const session = track(new V4Session(docWith(waitThenReturnByEvent(), flow), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().surface !== null, '挂载 surface')
    const surface = session.getSnapshot().surface!
    expect(surface.typeId).toBe('choice')
    expect(surface.components.map((c) => c.id)).toEqual(['prompt', 'choice1'])
    expect(session.getSurfaceStore()).not.toBeNull()
    session.dispatchSurfaceEvent('choice1', 'chosen', { score: 7 })
    await waitFor(() => session.getSnapshot().result !== null, '结算')
    expect(h.finished).toEqual([{ score: 7, passed: true }])
    expect(session.getSnapshot().surface).toBeNull()
  })

  it('题目执行期间 shell 事件被忽略并记 warning；surface 未知组件事件记 warning', async () => {
    const flow = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_finish', kind: 'finish', passed: 'local.r.status == "answered"' },
      ],
      [out('f_start', 'f_ask'), out('f_ask', 'f_finish')],
    )
    const h = makeHost()
    const session = track(new V4Session(docWith(waitThenReturnByEvent(), flow), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().surface !== null, '挂载 surface')
    session.dispatchShellEvent('scoreLabel', 'clicked')
    session.dispatchSurfaceEvent('ghost', 'x')
    expect(h.events.some((event) => event.kind === 'warning' && (event.message?.includes('忽略 shell') ?? false))).toBe(true)
    expect(
      h.events.some((event) => event.kind === 'warning' && (event.message?.includes('不存在的本地组件') ?? false)),
    ).toBe(true)
    session.dispatchSurfaceEvent('choice1', 'chosen', { score: 5 })
    await waitFor(() => session.getSnapshot().result !== null, '结算')
  })
})

describe('v4 session：watchdog / 取消 / 调试', () => {
  function waitForever(): BehaviorProgram {
    return behavior(
      [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_wait', kind: 'wait', ms: '5000' },
        { id: 'b_ret', kind: 'return', result: '{}' },
      ],
      [out('b_start', 'b_wait'), out('b_wait', 'b_ret')],
    )
  }

  it('watchdog 超时 → timeout 结果交给 flow（不卡死）', async () => {
    const flow = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_finish', kind: 'finish', passed: 'local.r.status == "timeout"' },
      ],
      [out('f_start', 'f_ask'), out('f_ask', 'f_finish')],
    )
    const h = makeHost({ budgets: { watchdogMs: 20 } })
    const session = track(new V4Session(docWith(waitForever(), flow), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().result !== null, '结算')
    expect(h.finished).toEqual([{ score: 0, passed: true }])
    expect(session.getSnapshot().surface).toBeNull()
  })

  it('dispose 中止进行中的 ask，不再产生结算', async () => {
    const h = makeHost()
    const session = track(new V4Session(docWith(waitForever(), askAllFlow()), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().surface !== null, '挂载 surface')
    session.dispose()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.finished).toEqual([])
    expect(session.getSnapshot().surface).toBeNull()
  })

  it('getDebugState：调用栈/四层作用域/牌堆/日志', async () => {
    const flow = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'local.r.scoreDelta' } },
        { id: 'f_finish', kind: 'finish', passed: 'v.score >= 3' },
      ],
      [out('f_start', 'f_ask'), out('f_ask', 'f_apply'), out('f_apply', 'f_finish')],
    )
    const h = makeHost()
    const session = track(new V4Session(docWith(waitThenReturnByEventFixture(), flow), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().surface !== null, '挂载 surface')
    const debug = session.getDebugState()
    expect(debug.callStack.map((frame) => frame.kind)).toEqual(['flow', 'behavior'])
    expect(debug.deck).toHaveLength(2)
    expect(debug.scopes.v).toMatchObject({ score: 0 })
    expect(debug.scopes.qState).toEqual({ answered: false })
    expect(debug.scopes.args).not.toBeNull()
    session.dispatchSurfaceEvent('choice1', 'chosen', { score: 3 })
    await waitFor(() => session.getSnapshot().result !== null, '结算')
  })
})

describe('v4 session：behavior foreach（v4.2）', () => {
  it('单题内遍历 q.options 累积 local/state；每行 q.state 独立', async () => {
    const doc = minimalLevelDoc()
    doc.content.types[0].state = [
      { key: 'answered', type: 'boolean', init: false },
      { key: 'joined', type: 'string', init: '' },
    ]
    doc.content.types[0].behavior = behavior(
      [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_fe', kind: 'foreach', items: 'q.options', itemVar: 'opt' },
        { id: 'b_join', kind: 'assign', target: 'q.state.joined', value: { expr: 'q.state.joined + local.opt' } },
        { id: 'b_ret', kind: 'return', result: "{ status: 'answered', scoreDelta: 0, payload: q.state.joined }" },
      ],
      [
        out('b_start', 'b_fe'),
        out('b_fe', 'b_join', 'true'),
        out('b_join', 'b_fe'),
        out('b_fe', 'b_ret', 'false'),
      ],
    )
    doc.content.flow = askAllFlow()
    const h = makeHost()
    const session = track(new V4Session(doc, h.host))
    session.start()
    await waitFor(() => session.getSnapshot().result !== null, '结算')
    expect(session.questionResults).toHaveLength(2)
    expect(session.questionResults[0].result.payload).toBe('DoReMi')
    expect(session.questionResults[1].result.payload).toBe('SolLa')
  })
})

function waitThenReturnByEventFixture(): BehaviorProgram {
  return behavior(
    [
      { id: 'b_start', kind: 'on', event: 'start' },
      { id: 'b_on', kind: 'on', event: 'choice1.chosen' },
      { id: 'b_ret', kind: 'return', result: "{ scoreDelta: event.payload.score }" },
    ],
    [out('b_on', 'b_ret')],
  )
}

// ---------------------------------------------------------------------------
// v4.1：题型内视图（docs/56）
// ---------------------------------------------------------------------------

describe('v4 session：题型内视图', () => {
  /** prompt 属 intro、choice 属 answer、startBtn 所有视图可见；行为在 startBtn 点击后切到 answer */
  function viewDoc(): LevelDocV4 {
    const doc = docWith(
      behavior(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_onStartBtn', kind: 'on', event: 'startBtn.clicked' },
          { id: 'b_view', kind: 'setView', view: 'answer' },
          { id: 'b_onChosen', kind: 'on', event: 'choice1.chosen' },
          { id: 'b_ret', kind: 'return', result: "{ status: 'answered', scoreDelta: q.scoring }" },
        ],
        [out('b_onStartBtn', 'b_view'), out('b_onChosen', 'b_ret')],
      ),
    )
    const type = doc.content.types[0]
    type.surface.views = [{ id: 'intro', name: '读题' }, { id: 'answer', name: '作答' }]
    type.surface.initialView = 'intro'
    type.surface.components[0].view = 'intro'
    type.surface.components[1].view = 'answer'
    type.surface.components.push({ id: 'startBtn', type: 'button', props: { text: '开始' } })
    return doc
  }

  it('每次 ask 从 initialView 开始；behavior setView 切视图；下一题回到初始视图', async () => {
    const h = makeHost()
    const session = track(new V4Session(viewDoc(), h.host))
    session.start()
    await waitFor(() => session.getSnapshot().surface !== null, '挂载第一帧')
    expect(session.getSnapshot().surface?.view).toBe('intro')
    expect(session.getSnapshot().surface?.components.map((c) => c.id)).toContain('prompt')

    session.dispatchSurfaceEvent('startBtn', 'clicked')
    await waitFor(() => session.getSnapshot().surface?.view === 'answer', '切到作答视图')
    session.dispatchSurfaceEvent('choice1', 'chosen', { index: 0 })
    await waitFor(() => session.getSnapshot().surface?.callId === 2, '挂载第二帧')
    expect(session.getSnapshot().surface?.view).toBe('intro')
    session.dispatchSurfaceEvent('startBtn', 'clicked')
    session.dispatchSurfaceEvent('choice1', 'chosen', { index: 0 })
    await waitFor(() => session.getSnapshot().result !== null, '结算')
  })

  it('没有题内视图时 setView 记运行错误，不改变帧视图', async () => {
    const doc = docWith(
      behavior(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_view', kind: 'setView', view: 'nope' },
          { id: 'b_on', kind: 'on', event: 'choice1.chosen' },
          { id: 'b_ret', kind: 'return', result: '{}' },
        ],
        [out('b_start', 'b_view'), out('b_on', 'b_ret')],
      ),
    )
    const h = makeHost()
    const session = track(new V4Session(doc, h.host))
    session.start()
    await waitFor(() => session.getSnapshot().surface !== null, '挂载 surface')
    expect(session.getSnapshot().surface?.view).toBe('')
    expect(h.events.some((event) => event.kind === 'error' && /没有题内视图/.test(event.message ?? ''))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// v4.1：全局时钟 run.elapsedMs（docs/56）
// ---------------------------------------------------------------------------

interface FakeClock {
  timer: TimerApi
  now(): number
  advance(ms: number): void
  tick(): void
  intervals: number
}

function fakeClock(initialMs = 0): FakeClock {
  let nowMs = initialMs
  const callbacks: { fn: () => void; cleared: boolean }[] = []
  const timer: TimerApi = {
    setTimeout: () => null,
    clearTimeout: () => {},
    setInterval: (fn) => {
      const record = { fn, cleared: false }
      callbacks.push(record)
      return record
    },
    clearInterval: (handle) => {
      const record = handle as { cleared?: boolean } | null
      if (record) record.cleared = true
    },
  }
  return {
    timer,
    now: () => nowMs / 1000,
    advance(ms) {
      nowMs += ms
    },
    tick() {
      for (const record of callbacks) if (!record.cleared) record.fn()
    },
    get intervals() {
      return callbacks.filter((record) => !record.cleared).length
    },
  }
}

function clockDoc(withClock: boolean): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.flow = flowProgram(
    [
      { id: 'f_start', kind: 'start' },
      { id: 'f_wait', kind: 'waitShell', event: 'btn1.clicked' },
      { id: 'f_finish', kind: 'finish', passed: 'true' },
    ],
    [out('f_start', 'f_wait'), out('f_wait', 'f_finish')],
  )
  doc.content.shell.components.push({ id: 'btn1', type: 'button', view: 'main', layout: { x: 20, y: 60, w: 120, h: 40 } })
  if (withClock) {
    doc.content.shell.components.push({
      id: 'clockLabel',
      type: 'label',
      view: 'main',
      layout: { x: 20, y: 100, w: 240, h: 32 },
      bindings: { text: "'t=' + floor(run.elapsedMs / 1000)" },
    })
  }
  return doc
}

describe('v4 session：全局时钟 run.elapsedMs', () => {
  function clockText(session: V4Session): string {
    const state = session.shellStore.snapshot('clockLabel').state as { text?: string } | null
    return state?.text ?? ''
  }

  it('有 run.elapsedMs 绑定 → 100ms tick 刷新 shell 显示；finish 定格；restart 归零', async () => {
    const clock = fakeClock()
    const h = makeHost()
    const session = track(new V4Session(clockDoc(true), { ...h.host, getNowSeconds: () => clock.now(), timer: clock.timer }))
    session.start()
    expect(clock.intervals).toBe(1)
    expect(clockText(session)).toBe('t=0')

    clock.advance(1500)
    clock.tick()
    expect(clockText(session)).toBe('t=1')

    await waitFor(() => session.waitingShellEvents.includes('btn1.clicked'), '流程停在 waitShell')
    session.dispatchShellEvent('btn1', 'clicked')
    await waitFor(() => session.getSnapshot().result !== null, '结算')
    expect(clock.intervals).toBe(0)
    clock.advance(3000)
    clock.tick()
    expect(clockText(session)).toBe('t=1')

    session.restart()
    expect(clock.intervals).toBe(1)
    expect(clockText(session)).toBe('t=0')
    clock.advance(800)
    clock.tick()
    expect(clockText(session)).toBe('t=0')
  })

  it('没有时钟绑定时不起 tick 定时器；behavior 仍可在事件里读到实时 run.elapsedMs', async () => {
    const clock = fakeClock()
    const doc = clockDoc(false)
    doc.content.flow = askAllFlow()
    doc.content.types[0].behavior = behavior(
      [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_t0', kind: 'assign', target: 'q.state.t0', value: { expr: 'run.elapsedMs' } },
        { id: 'b_on', kind: 'on', event: 'choice1.chosen' },
        { id: 'b_ret', kind: 'return', result: "{ status: 'answered', payload: run.elapsedMs - q.state.t0, scoreDelta: q.scoring }" },
      ],
      [out('b_start', 'b_t0'), out('b_on', 'b_ret')],
    )
    const h = makeHost()
    const session = track(new V4Session(doc, { ...h.host, getNowSeconds: () => clock.now(), timer: clock.timer }))
    session.start()
    await waitFor(() => session.getSnapshot().surface !== null, '挂载 surface')
    expect(clock.intervals).toBe(0)
    clock.advance(1234)
    session.dispatchSurfaceEvent('choice1', 'chosen', { index: 0 })
    await waitFor(() => session.getSnapshot().surface?.callId === 2, '第二题')
    expect(session.questionResults[0].result.payload).toBe(1234)
  })

  it('debug 暂停计时器时全局时钟冻结（暂停区间不计入 elapsedMs）', () => {
    const clock = fakeClock()
    const h = makeHost()
    const session = track(new V4Session(clockDoc(true), { ...h.host, getNowSeconds: () => clock.now(), timer: clock.timer }))
    session.start()
    clock.advance(1000)
    clock.tick()
    expect(clockText(session)).toBe('t=1')

    session.setTimersPaused(true)
    clock.advance(5000)
    clock.tick()
    expect(clockText(session)).toBe('t=1')

    session.setTimersPaused(false)
    clock.advance(1000)
    clock.tick()
    expect(clockText(session)).toBe('t=2')
  })
})
