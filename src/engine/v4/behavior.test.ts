import { afterEach, describe, expect, it, vi } from 'vitest'
import { BehaviorRunner, type BehaviorHost } from './behavior'
import { CancelToken } from './interpreter'
import { BEHAVIOR_ROOTS, evalV4, writeEnvPath } from './expr'
import type { Json } from '../expr'
import type { BehaviorNode, BehaviorProgram, GraphEdge } from './model'

interface BState {
  qState: Record<string, Json>
  t: Record<string, Json>
  local: Record<string, Json>
  args: Record<string, Json>
  v: Record<string, Json>
  run: Record<string, Json>
  commands: { target: string; method: string; arg: Json }[]
  queries: { target: string; method: string }[]
  logs: { level: string; message: string }[]
  sleeps: number[]
  views: string[]
}

function makeHost(): { host: BehaviorHost; state: BState } {
  const state: BState = {
    qState: { answered: false },
    t: { asked: 0 },
    local: {},
    args: { difficulty: 1 },
    v: { score: 0 },
    run: { total: 1, seed: 1, index: 0, questions: [] },
    commands: [],
    queries: [],
    logs: [],
    sleeps: [],
    views: [],
  }
  const qContent = () => ({
    id: 'row_01',
    prompt: '题面',
    options: ['A', 'B'],
    scoring: 10,
    state: state.qState,
  })
  const host: BehaviorHost = {
    evalExprForEvent(src, event) {
      return evalV4(
        src,
        {
          q: qContent() as unknown as Json,
          t: state.t,
          local: state.local,
          args: state.args,
          v: state.v,
          run: state.run,
          event,
        },
        BEHAVIOR_ROOTS,
      )
    },
    evalExpr(src) {
      return this.evalExprForEvent(src, null)
    },
    writeTarget(target, value) {
      writeEnvPath(
        { q: { state: state.qState } as unknown as Json, t: state.t, local: state.local },
        target,
        value,
      )
    },
    setLocal(name, value) {
      state.local[name] = value
    },
    readLocal(name) {
      return state.local[name] ?? null
    },
    command(target, method, arg) {
      state.commands.push({ target, method, arg })
    },
    query(target, method) {
      state.queries.push({ target, method })
      return null
    },
    setView(view) {
      state.views.push(view)
    },
    async sleep(ms) {
      state.sleeps.push(ms)
      await new Promise<void>((resolve) => setTimeout(resolve, ms))
    },
    log(level, message) {
      state.logs.push({ level, message })
    },
  }
  return { host, state }
}

function program(nodes: BehaviorNode[], edges: GraphEdge[]): BehaviorProgram {
  return { logicVersion: 3, kind: 'behavior', nodes, edges }
}

function out(from: string, to: string, port?: 'true' | 'false'): GraphEdge {
  return { id: `e_${from}_${to}_${port ?? 'out'}`, from, to, ...(port ? { port } : {}) }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('v4 behavior：start / return', () => {
  it('start→return：结果归一化，status 缺省 answered', async () => {
    const { host } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_on', kind: 'on', event: 'start' },
          { id: 'b_ret', kind: 'return', result: "{ correct: true, scoreDelta: 10 }" },
        ],
        [out('b_on', 'b_ret')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    await expect(runner.run()).resolves.toEqual({
      kind: 'return',
      result: { status: 'answered', correct: true, scoreDelta: 10 },
    })
    expect(runner.isFinished).toBe(true)
  })

  it('非法返回值 → normalize 为 status:error 的 return 结果', async () => {
    const { host } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_on', kind: 'on', event: 'start' },
          { id: 'b_ret', kind: 'return', result: "'not an object'" },
        ],
        [out('b_on', 'b_ret')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    const outcome = await runner.run()
    expect(outcome.kind).toBe('return')
    if (outcome.kind === 'return') expect(outcome.result.status).toBe('error')
  })
  it('v4.1 setView 节点：调用宿主 setView（失败/未知视图由宿主处理）', async () => {
    const { host, state } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_on', kind: 'on', event: 'start' },
          { id: 'b_view', kind: 'setView', view: 'answer' },
          { id: 'b_ret', kind: 'return', result: '{}' },
        ],
        [out('b_on', 'b_view'), out('b_view', 'b_ret')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    await runner.run()
    expect(state.views).toEqual(['answer'])
  })
})

describe('v4 behavior：组件事件 / payload / return 竞态', () => {
  it('等待组件事件后 return；event.payload 可读', async () => {
    const { host } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_wait', kind: 'wait', ms: '1000' },
          { id: 'b_fallback', kind: 'return', result: "{ correct: false }" },
          { id: 'b_on', kind: 'on', event: 'choice.chosen' },
          { id: 'b_ret', kind: 'return', result: "{ correct: event.payload.index == 1 }" },
        ],
        [out('b_start', 'b_wait'), out('b_wait', 'b_fallback'), out('b_on', 'b_ret')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    const promise = runner.run()
    runner.dispatch('choice.chosen', { index: 1 })
    const outcome = await promise
    expect(outcome).toEqual({ kind: 'return', result: { status: 'answered', correct: true } })
  })

  it('return 首个生效：同事件多 handler 按程序顺序，之后事件丢弃', async () => {
    const { host } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_on', kind: 'on', event: 'go' },
          { id: 'b_ret1', kind: 'return', result: "{ scoreDelta: 1 }" },
          { id: 'b_on2', kind: 'on', event: 'go' },
          { id: 'b_ret2', kind: 'return', result: "{ scoreDelta: 2 }" },
        ],
        [out('b_on', 'b_ret1'), out('b_on2', 'b_ret2')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    const promise = runner.run().catch(() => null) // 无 start handler → error；改由 go 事件驱动
    expect((await promise)?.kind).toBe('error') // 缺少 on start 直接 error
    const runner2 = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_wait', kind: 'wait', ms: '1000' },
          { id: 'b_on', kind: 'on', event: 'go' },
          { id: 'b_ret1', kind: 'return', result: "{ scoreDelta: 1 }" },
          { id: 'b_on2', kind: 'on', event: 'go' },
          { id: 'b_ret2', kind: 'return', result: "{ scoreDelta: 2 }" },
        ],
        [
          out('b_start', 'b_wait'),
          out('b_on', 'b_ret1'),
          out('b_on2', 'b_ret2'),
        ],
      ),
      host,
      { cancel: new CancelToken() },
    )
    const promise2 = runner2.run()
    runner2.dispatch('go', {})
    const outcome = await promise2
    expect(outcome).toEqual({ kind: 'return', result: { status: 'answered', scoreDelta: 1 } })
    runner2.dispatch('go', {})
    expect(runner2.isFinished).toBe(true)
  })
})

describe('v4 behavior：wait 不阻塞其它任务 / emit', () => {
  it('start 任务 wait 期间，事件任务可先 return', async () => {
    vi.useFakeTimers()
    const { host } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_wait', kind: 'wait', ms: '100' },
          { id: 'b_slow', kind: 'return', result: "{ correct: false }" },
          { id: 'b_fast', kind: 'on', event: 'fast' },
          { id: 'b_fast_ret', kind: 'return', result: "{ correct: true }" },
        ],
        [out('b_start', 'b_wait'), out('b_wait', 'b_slow'), out('b_fast', 'b_fast_ret')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    const promise = runner.run()
    runner.dispatch('fast', {})
    const outcome = await promise
    expect(outcome).toEqual({ kind: 'return', result: { status: 'answered', correct: true } })
    expect(host['log']).toBeTruthy()
  })

  it('emit → 内部事件 on 处理器；payload 传递', async () => {
    const { host } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_emit', kind: 'emit', event: 'internal.judged', payload: { ok: 'true' } },
          { id: 'b_internal', kind: 'on', event: 'internal.judged' },
          { id: 'b_ret', kind: 'return', result: "{ correct: event.payload.ok }" },
        ],
        [out('b_start', 'b_emit'), out('b_internal', 'b_ret')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    const outcome = await runner.run()
    expect(outcome).toEqual({ kind: 'return', result: { status: 'answered', correct: true } })
  })
})

describe('v4 behavior：取消 / 预算 / 事件上限 / 任务错误', () => {
  it('外部取消 → aborted', async () => {
    const { host } = makeHost()
    const cancel = new CancelToken()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_wait', kind: 'wait', ms: '1000' },
          { id: 'b_ret', kind: 'return', result: '{}' },
        ],
        [out('b_start', 'b_wait'), out('b_wait', 'b_ret')],
      ),
      host,
      { cancel },
    )
    const promise = runner.run()
    cancel.cancel()
    await expect(promise).resolves.toEqual({ kind: 'aborted' })
  })

  it('步数预算超限 → error；事件数超限 → error', async () => {
    vi.useFakeTimers()
    const { host } = makeHost()
    const overBudget = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_assign', kind: 'assign', target: 'q.state.answered', value: { expr: 'true' } },
          { id: 'b_ret', kind: 'return', result: '{}' },
        ],
        [out('b_start', 'b_assign'), out('b_assign', 'b_ret')],
      ),
      host,
      { cancel: new CancelToken(), maxSteps: 1 },
    )
    const budgetOutcome = await overBudget.run()
    expect(budgetOutcome.kind).toBe('error')

    const events = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_wait', kind: 'wait', ms: '1000' },
          { id: 'b_ret', kind: 'return', result: '{}' },
          { id: 'b_go', kind: 'on', event: 'go' },
          { id: 'b_go_ret', kind: 'return', result: '{}' },
        ],
        [out('b_start', 'b_wait'), out('b_wait', 'b_ret'), out('b_go', 'b_go_ret')],
      ),
      host,
      { cancel: new CancelToken(), maxEvents: 2 },
    )
    const eventsPromise = events.run()
    events.dispatch('go', {})
    events.dispatch('go', {})
    events.dispatch('go', {})
    const eventsOutcome = await eventsPromise
    expect(eventsOutcome.kind).toBe('error')
  })

  it('任务内节点错误 → error 结果（指定 message）', async () => {
    const { host } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_bad', kind: 'assign', target: 'v.score', value: { expr: '1' } },
          { id: 'b_ret', kind: 'return', result: '{}' },
        ],
        [out('b_start', 'b_bad'), out('b_bad', 'b_ret')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    const outcome = await runner.run()
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.result.status).toBe('error')
      expect(outcome.message).toMatch(/未定义的作用域根|ghost|未初始化|未知属性/)
    }
  })

  it('空 handler（on 无后续节点）不结束调用；其它事件仍可 return', async () => {
    const { host } = makeHost()
    const runner = new BehaviorRunner(
      program(
        [
          { id: 'b_start', kind: 'on', event: 'start' },
          { id: 'b_go', kind: 'on', event: 'go' },
          { id: 'b_ret', kind: 'return', result: "{ correct: true }" },
        ],
        [out('b_go', 'b_ret')],
      ),
      host,
      { cancel: new CancelToken() },
    )
    const promise = runner.run()
    runner.dispatch('go', {})
    await expect(promise).resolves.toEqual({ kind: 'return', result: { status: 'answered', correct: true } })
  })
})
