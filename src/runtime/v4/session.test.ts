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
import { V4Session, type V4SessionHost } from './session'

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
