import { describe, expect, it } from 'vitest'
import {
  BudgetExceededError,
  CancelToken,
  CancelledError,
  FlowRuntimeError,
  GraphIndex,
  StepBudget,
  execSharedNode,
  runChain,
  sleepWithCancel,
  type GraphNodeLike,
  type SharedEnv,
  type WalkFrame,
} from './interpreter'
import type { Json } from '../expr'
import type { GraphEdge } from './model'

interface EnvRecorder {
  env: SharedEnv
  writes: { target: string; value: Json }[]
  locals: Record<string, Json>
  commands: { target: string; method: string; arg: Json }[]
  queries: { target: string; method: string; arg?: Json }[]
  sleeps: number[]
}

function makeEnv(values: Record<string, Json> = {}, queryResult: Json = 'query-result'): EnvRecorder {
  const recorder: EnvRecorder = {
    writes: [],
    locals: {},
    commands: [],
    queries: [],
    sleeps: [],
    env: {
      evalExpr(src) {
        if (Object.prototype.hasOwnProperty.call(values, src)) return values[src]
        const n = Number(src)
        return Number.isFinite(n) ? n : null
      },
      writeTarget(target, value) {
        recorder.writes.push({ target, value })
      },
      setLocal(name, value) {
        recorder.locals[name] = value
      },
      readLocal(name) {
        return recorder.locals[name] ?? null
      },
      command(target, method, arg) {
        recorder.commands.push({ target, method, arg })
      },
      query(target, method, arg) {
        recorder.queries.push({ target, method, arg })
        return queryResult
      },
      async sleep(ms) {
        recorder.sleeps.push(ms)
      },
    },
  }
  return recorder
}

function frame(): WalkFrame {
  return { loopState: new Map() }
}

function node(id: string, kind: string, extra: Record<string, Json> = {}): GraphNodeLike {
  return { id, kind, ...extra } as unknown as GraphNodeLike
}

function edge(from: string, to: string, port?: 'true' | 'false'): GraphEdge {
  return { id: `e_${from}_${to}_${port ?? 'out'}`, from, to, ...(port ? { port } : {}) }
}

function program(nodes: GraphNodeLike[], edges: GraphEdge[]): { nodes: GraphNodeLike[]; edges: GraphEdge[] } {
  return { nodes, edges }
}

describe('v4 interpreter：GraphIndex', () => {
  it('按端口取后继；单出口无 port；无出边返回 null', () => {
    const index = new GraphIndex(
      program([node('a', 'branch'), node('b', 'assign'), node('c', 'assign')], [
        edge('a', 'b', 'true'),
        edge('a', 'c', 'false'),
      ]),
    )
    expect(index.next('a', 'true')).toBe('b')
    expect(index.next('a', 'false')).toBe('c')
    expect(index.next('a')).toBeNull()
    expect(index.next('b')).toBeNull()
    expect(index.outDegree('a')).toBe(2)
    expect(index.node('b')?.id).toBe('b')
  })

  it('runChain 线性执行、无出边停止、预算/取消生效', async () => {
    const order: string[] = []
    const index = new GraphIndex(program([node('a', 'x'), node('b', 'x'), node('c', 'x')], [edge('a', 'b'), edge('b', 'c')]))
    await runChain({
      entry: 'a',
      index,
      cancel: new CancelToken(),
      budget: new StepBudget(10),
      exec: async (n) => {
        order.push(n.id)
      },
    })
    expect(order).toEqual(['a', 'b', 'c'])

    await expect(
      runChain({
        entry: 'a',
        index,
        cancel: new CancelToken(),
        budget: new StepBudget(2),
        exec: async (n) => {
          order.push(n.id)
        },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError)

    const cancel = new CancelToken()
    cancel.cancel()
    await expect(
      runChain({ entry: 'a', index, cancel, budget: new StepBudget(10), exec: async () => {} }),
    ).rejects.toBeInstanceOf(CancelledError)
  })
})

describe('v4 interpreter：共享节点语义', () => {
  it('assign：expr 与 query 两条右侧；写入目标由 env 决定', async () => {
    const rec = makeEnv({ 'v.score + 1': 11 })
    await execSharedNode(node('n', 'assign', { target: 'v.score', value: { expr: 'v.score + 1' } }), frame(), rec.env, new CancelToken())
    expect(rec.writes).toEqual([{ target: 'v.score', value: 11 }])

    const rec2 = makeEnv()
    await execSharedNode(
      node('n', 'assign', { target: 'v.x', value: { query: { target: 'input1', method: 'getValue' } } }),
      frame(),
      rec2.env,
      new CancelToken(),
    )
    expect(rec2.queries).toEqual([{ target: 'input1', method: 'getValue', arg: undefined }])
    expect(rec2.writes).toEqual([{ target: 'v.x', value: 'query-result' }])
  })

  it('call：参数缺省 {}；非对象参数报错', async () => {
    const rec = makeEnv()
    await execSharedNode(node('n', 'call', { target: 'label1', method: 'setText' }), frame(), rec.env, new CancelToken())
    expect(rec.commands[0]).toMatchObject({ target: 'label1', method: 'setText', arg: {} })

    const bad = makeEnv({ bad: 42 })
    await expect(
      execSharedNode(node('n', 'call', { target: 'label1', method: 'setText', arg: 'bad' }), frame(), bad.env, new CancelToken()),
    ).rejects.toBeInstanceOf(FlowRuntimeError)
  })

  it('branch 端口', async () => {
    const rec = makeEnv({ yes: true, no: false })
    const t = await execSharedNode(node('b', 'branch', { cond: 'yes' }), frame(), rec.env, new CancelToken())
    const f = await execSharedNode(node('b', 'branch', { cond: 'no' }), frame(), rec.env, new CancelToken())
    expect(t).toEqual({ port: 'true' })
    expect(f).toEqual({ port: 'false' })
  })

  it('loop repeat：状态存于 frame，按次数 true→false', async () => {
    const rec = makeEnv()
    const f = frame()
    const loop = node('l', 'loop', { mode: 'repeat', times: '2' })
    const results = []
    for (let i = 0; i < 3; i++) results.push(await execSharedNode(loop, f, rec.env, new CancelToken()))
    expect(results).toEqual([{ port: 'true' }, { port: 'true' }, { port: 'false' }])
    expect(f.loopState.size).toBe(0)
  })

  it('loop while：每轮重新求值 cond', async () => {
    const rec = makeEnv({ cond: true })
    const f = frame()
    const loop = node('l', 'loop', { mode: 'while', cond: 'cond' })
    expect(await execSharedNode(loop, f, rec.env, new CancelToken())).toEqual({ port: 'true' })
    rec.env.evalExpr = () => false
    expect(await execSharedNode(loop, f, rec.env, new CancelToken())).toEqual({ port: 'false' })
  })

  it('foreach：初始化 items、逐项写 itemVar/indexVar、结束走 false', async () => {
    const rec = makeEnv({ 'run.questions': [{ id: 'a' }, { id: 'b' }] })
    const f = frame()
    const nodeForeach = node('f', 'foreach', { items: 'run.questions', itemVar: 'slot', indexVar: 'i' })
    const results = []
    const seen: Json[] = []
    for (let i = 0; i < 4; i++) {
      results.push(await execSharedNode(nodeForeach, f, rec.env, new CancelToken()))
      seen.push(rec.locals.i ?? null)
    }
    expect(results).toEqual([{ port: 'true' }, { port: 'true' }, { port: 'false' }, { port: 'true' }])
    expect(seen.slice(0, 2)).toEqual([0, 1])
    expect(f.loopState.size).toBe(1) // 第 4 次重新开始（新迭代）
  })

  it('foreach items 非数组报错；wait 调 sleep；comment 直通', async () => {
    const rec = makeEnv({ notArray: 1 })
    await expect(
      execSharedNode(
        node('f', 'foreach', { items: 'notArray', itemVar: 'x' }),
        frame(),
        rec.env,
        new CancelToken(),
      ),
    ).rejects.toBeInstanceOf(FlowRuntimeError)

    await execSharedNode(node('w', 'wait', { ms: '5' }), frame(), rec.env, new CancelToken())
    expect(rec.sleeps).toEqual([5])

    expect(await execSharedNode(node('c', 'comment', { text: 'hi' }), frame(), rec.env, new CancelToken())).toEqual({})
    expect(await execSharedNode(node('x', 'ask', {}), frame(), rec.env, new CancelToken())).toBeNull()
  })
})

describe('v4 interpreter：sleepWithCancel', () => {
  it('正常 resolve；取消 reject CancelledError；0/负数立即完成', async () => {
    await expect(sleepWithCancel(1, new CancelToken())).resolves.toBeUndefined()
    await expect(sleepWithCancel(0, new CancelToken())).resolves.toBeUndefined()
    await expect(sleepWithCancel(-5, new CancelToken())).resolves.toBeUndefined()

    const cancel = new CancelToken()
    const pending = sleepWithCancel(10_000, cancel)
    cancel.cancel()
    await expect(pending).rejects.toBeInstanceOf(CancelledError)
  })
})
