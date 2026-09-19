import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addNode, blankGraphProgram, connect, type GNode, type GraphProgram } from './graphProgram'
import { GraphEngine, type GraphHost } from './graphEngine'
import type { Json } from './expr'

interface Recorded {
  path: string
  args: Json
}

function makeHost(overrides?: Partial<GraphHost> & { queryValues?: Record<string, Json> }): { host: GraphHost; commands: Recorded[]; errors: unknown[] } {
  const commands: Recorded[] = []
  const errors: unknown[] = []
  const host: GraphHost = {
    getQuestion: () => ({ id: 'q1', data: { target: 60 }, scoring: { max: 10 } }) as Json,
    dispatchCommand: (path, args) => {
      commands.push({ path, args })
    },
    queryComponent: (target, method) => {
      const key = `${target}.${method}`
      const values = overrides?.queryValues ?? {}
      if (!(key in values)) throw new Error(`无该查询: ${key}`)
      return values[key]
    },
    onError: (err) => errors.push(err),
    ...overrides,
  }
  return { host, commands, errors }
}

function linked(nodes: GNode[], links: [string, string, ('true' | 'false')?][]): GraphProgram {
  let p = blankVars()
  p = { ...p, variables: { ...p.variables, i: 0, j: 0, done: false } }
  for (const n of nodes) p = addNode(p, n)
  for (const [from, to, port] of links) p = connect(p, from, to, port)
  return p
}

const assign = (id: string, target: string, expr: string): GNode => ({ id, kind: 'assign', target, value: { expr } })
const call = (id: string, target: string, method: string, args: string[] = []): GNode => ({ id, kind: 'call', target, method, args })

function blankVars(): GraphProgram {
  return { ...blankGraphProgram(), variables: { score: 0, i: 0, done: false } }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('GraphEngine 基础', () => {
  it('on → call 链：命令带首参（args [] → {}）', async () => {
    let p = linked([call('s', 'sound1', 'play'), call('t', 'label1', 'show', ['{text: v.i}'])], [['s', 't']])
    p = addNode(p, { id: 'e', kind: 'on', event: 'level.started' })
    p = connect(p, 'e', 's')
    const { host, commands } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('level.started', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(commands).toEqual([
      { path: 'sound1.play', args: {} },
      { path: 'label1.show', args: { text: 0 } },
    ])
  })

  it('assign 表达式与变量累加', async () => {
    let p = linked([assign('a', 'score', 'v.score + q.scoring.max'), assign('b', 'label', "'x' + 1")], [['a', 'b']])
    p = addNode(p, { id: 'e', kind: 'on', event: 'app:go' })
    p = connect(p, 'e', 'a')
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:go', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.score).toBe(10)
    expect(engine.vars.label).toBe('x1')
  })

  it('同一事件的多个处理器按程序顺序执行', async () => {
    let p = blankVars()
    p = addNode(p, { id: 'e1', kind: 'on', event: 'app:x' })
    p = addNode(p, assign('a1', 'i', 'v.i + 1'))
    p = connect(p, 'e1', 'a1')
    p = addNode(p, { id: 'e2', kind: 'on', event: 'app:x' })
    p = addNode(p, assign('a2', 'i', 'v.i + 10'))
    p = connect(p, 'e2', 'a2')
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.i).toBe(11)
  })
})

describe('GraphEngine 控制流', () => {
  it('branch：true/false 端口；缺 false 边 = 结束', async () => {
    let p = blankVars()
    p = addNode(p, { id: 'e', kind: 'on', event: 'app:x' })
    p = addNode(p, { id: 'b', kind: 'branch', cond: 'event.v' })
    p = addNode(p, assign('t', 'i', '1'))
    p = connect(p, 'e', 'b')
    p = connect(p, 'b', 't', 'true')
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', { v: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.i).toBe(1)
    engine.reset()
    engine.dispatch('app:x', { v: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.i).toBe(0)
  })

  it('while 循环计数与循环后继', async () => {
    let p = blankVars()
    p = addNode(p, { id: 'e', kind: 'on', event: 'app:x' })
    p = addNode(p, { id: 'w', kind: 'loop', mode: 'while', cond: 'v.i < 5' })
    p = addNode(p, assign('b', 'i', 'v.i + 1'))
    p = connect(p, 'e', 'w')
    p = connect(p, 'w', 'b', 'true')
    p = connect(p, 'b', 'w') // 回边
    p = addNode(p, assign('z', 'done', 'true'))
    p = connect(p, 'w', 'z', 'false')
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.i).toBe(5)
    expect(engine.vars.done).toBe(true)
  })

  it('repeat 计数；外层再次进入时重置计数', async () => {
    // 外层 while 2 轮，每轮 repeat 3 次 → i 终值 6
    let p = blankVars()
    p = addNode(p, { id: 'e', kind: 'on', event: 'app:x' })
    p = addNode(p, { id: 'outer', kind: 'loop', mode: 'while', cond: 'v.i < 6' })
    p = addNode(p, { id: 'r', kind: 'loop', mode: 'repeat', times: '3' })
    p = addNode(p, assign('b', 'i', 'v.i + 1'))
    p = connect(p, 'e', 'outer')
    p = connect(p, 'outer', 'r', 'true')
    p = connect(p, 'r', 'b', 'true')
    p = connect(p, 'b', 'r') // 内层回边
    p = connect(p, 'r', 'outer', 'false') // 内层完 → 回外层头（外层体尾回边）
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.i).toBe(6)
  })

  it('节点预算：while(true) 死循环被拦截且不崩溃', async () => {
    let p = blankVars()
    p = addNode(p, { id: 'e', kind: 'on', event: 'app:x' })
    p = addNode(p, { id: 'w', kind: 'loop', mode: 'while', cond: 'true' })
    p = addNode(p, assign('b', 'i', 'v.i + 1'))
    p = connect(p, 'e', 'w')
    p = connect(p, 'w', 'b', 'true')
    p = connect(p, 'b', 'w')
    const { host, errors } = makeHost({ budgets: { maxNodes: 32 } })
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/预算/)
  })
})

describe('GraphEngine 异步与竞态', () => {
  it('wait 后继续执行后续节点', async () => {
    let p = linked(
      [{ id: 'e', kind: 'on', event: 'app:x' }, { id: 'wt', kind: 'wait', ms: '50' }, assign('n', 'i', '99')],
      [
        ['e', 'wt'],
        ['wt', 'n'],
      ],
    )
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.i).toBe(0)
    await vi.advanceTimersByTimeAsync(60)
    expect(engine.vars.i).toBe(99)
  })

  it('wait 期间 reset：后续节点不再执行', async () => {
    let p = linked(
      [{ id: 'e', kind: 'on', event: 'app:x' }, { id: 'wt', kind: 'wait', ms: '50' }, assign('n', 'i', '99')],
      [
        ['e', 'wt'],
        ['wt', 'n'],
      ],
    )
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', {})
    await vi.advanceTimersByTimeAsync(0)
    engine.reset()
    await vi.advanceTimersByTimeAsync(100)
    expect(engine.vars.i).toBe(0)
  })
})

describe('GraphEngine 级联与查询', () => {
  it('emit 级联：A 处理器 emit B，B 处理器执行', async () => {
    let p = blankVars()
    p = addNode(p, { id: 'e1', kind: 'on', event: 'app:a' })
    p = addNode(p, { id: 'm', kind: 'emit', event: 'app:b', payload: { n: 'v.i + 1' } })
    p = connect(p, 'e1', 'm')
    p = addNode(p, assign('s', 'i', 'event.n * 10'))
    p = addNode(p, { id: 'e2', kind: 'on', event: 'app:b' })
    p = connect(p, 'e2', 's')
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:a', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.i).toBe(10)
  })

  it('级联预算：互 emit 被拦截', async () => {
    let p = blankVars()
    p = addNode(p, { id: 'e1', kind: 'on', event: 'app:a' })
    p = addNode(p, { id: 'm1', kind: 'emit', event: 'app:b' })
    p = connect(p, 'e1', 'm1')
    p = addNode(p, { id: 'e2', kind: 'on', event: 'app:b' })
    p = addNode(p, { id: 'm2', kind: 'emit', event: 'app:a' })
    p = connect(p, 'e2', 'm2')
    const { host, errors } = makeHost({ budgets: { maxEvents: 8 } })
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:a', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(errors.some((e) => String(e).includes('级联超过预算'))).toBe(true)
  })

  it('assign 右侧查询方法调用；宿主缺查询实现时报错不崩', async () => {
    let p = blankVars()
    p = addNode(p, { id: 'e', kind: 'on', event: 'app:x' })
    p = addNode(p, { id: 'r', kind: 'assign', target: 'reading', value: { call: { target: 'input1', method: 'getValue', args: [] } } })
    p = addNode(p, { id: 'r2', kind: 'assign', target: 'done', value: { call: { target: 'slider1', method: 'getValue', args: [] } } })
    p = connect(p, 'e', 'r')
    p = connect(p, 'r', 'r2')
    // queryValues 只注册了 input1：slider1 查询抛错 → onError 且处理器中断
    const { host, errors } = makeHost({ queryValues: { 'input1.getValue': 'abc' } })
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.reading).toBe('abc')
    expect(errors).toHaveLength(1)
    expect(engine.vars.done).toBe(false)
  })

  it('v1 程序构造时透明迁移', async () => {
    const { host, commands } = makeHost()
    const engine = new GraphEngine(
      { variables: { score: 0 }, rules: [{ id: 'r1', on: 'app:x', do: [{ set: 'score', expr: '42' }] }] },
      host,
    )
    engine.dispatch('app:x', {})
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.score).toBe(42)
    expect(commands).toEqual([])
  })

  it('resolve 与 evaluate（flow.pass / bindings 用）', () => {
    const p = blankGraphProgram()
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    expect(engine.resolve({ notes: '$q.data.target', n: 1 })).toEqual({ notes: 60, n: 1 })
    expect(engine.resolve('$expr:v.score + 1')).toBe(1)
    expect(engine.evaluate('v.score >= 1')).toBe(false)
    engine.vars.score = 5
    expect(engine.evaluate('v.score >= 1')).toBe(true)
  })

  it('reset 清空未处理队列', async () => {
    let p = blankVars()
    p = addNode(p, { id: 'e', kind: 'on', event: 'app:x' })
    p = addNode(p, assign('a', 'i', 'v.i + 1'))
    p = connect(p, 'e', 'a')
    const { host } = makeHost()
    const engine = new GraphEngine(p, host)
    engine.dispatch('app:x', {})
    engine.reset()
    await vi.advanceTimersByTimeAsync(0)
    expect(engine.vars.i).toBe(0)
  })
})
