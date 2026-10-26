import { describe, expect, it } from 'vitest'
import { FlowRunner, type FlowHost } from './flow'
import { CancelToken, type SharedEnv } from './interpreter'
import { FLOW_ROOTS, evalV4, writeEnvPath } from './expr'
import type { Json } from '../expr'
import type { FlowNode, FlowProgram, GraphEdge, QuestionResult, StateFieldDef } from './model'

interface HostState {
  vars: Record<string, Json>
  locals: Record<string, Json>
  run: Json
  asks: { target: unknown; args: unknown }[]
  waits: string[]
  views: string[]
  finished: boolean[]
  sleeps: number[]
  logs: { level: string; message: string; nodeId?: string }[]
  commands: { target: string; method: string; arg: Json }[]
  queries: { target: string; method: string; arg?: Json }[]
}

interface TestHost {
  host: FlowHost
  state: HostState
}

function makeHost(
  askResults: QuestionResult[] = [],
  runQuestions: Json[] = [{ type: 'choice', row: 'row_01', slotIndex: 0 }],
): TestHost {
  const state: HostState = {
    vars: { score: 0, n: 0 },
    locals: {},
    run: { questions: runQuestions, total: runQuestions.length, seed: 1, index: 0 },
    asks: [],
    waits: [],
    views: [],
    finished: [],
    sleeps: [],
    logs: [],
    commands: [],
    queries: [],
  }
  const env: SharedEnv = {
    evalExpr(src) {
      return evalV4(src, { v: state.vars, local: state.locals, run: state.run }, FLOW_ROOTS)
    },
    writeTarget(target, value) {
      writeEnvPath({ v: state.vars, local: state.locals, run: state.run }, target, value)
    },
    setLocal(name, value) {
      state.locals[name] = value
    },
    readLocal(name) {
      return state.locals[name] ?? null
    },
    command(target, method, arg) {
      state.commands.push({ target, method, arg })
    },
    query(target, method, arg) {
      state.queries.push({ target, method, arg })
      return null
    },
    async sleep(ms) {
      state.sleeps.push(ms)
    },
  }
  const host: FlowHost = {
    ...env,
    async ask(target, args) {
      state.asks.push({ target, args })
      const next = askResults.shift()
      return next ?? { status: 'answered', correct: true, scoreDelta: 10 }
    },
    async waitShell(event) {
      state.waits.push(event)
    },
    setView(view) {
      state.views.push(view)
    },
    finish(passed) {
      state.finished.push(passed)
    },
    log(level, message, nodeId) {
      state.logs.push({ level, message, nodeId })
    },
  }
  return { host, state }
}

const VARS: StateFieldDef[] = [
  { key: 'score', type: 'number', init: 0 },
  { key: 'n', type: 'number', init: 0 },
]

function flowProgram(nodes: FlowNode[], edges: GraphEdge[]): FlowProgram {
  return { logicVersion: 3, kind: 'flow', nodes, edges, vars: VARS }
}

function out(from: string, to: string, port?: 'true' | 'false'): GraphEdge {
  return { id: `e_${from}_${to}_${port ?? 'out'}`, from, to, ...(port ? { port } : {}) }
}

async function run(program: FlowProgram, host: TestHost, maxSteps?: number) {
  const runner = new FlowRunner(program, host.host, { cancel: new CancelToken(), maxSteps })
  return runner.run()
}

describe('v4 flow：顺序 / finish / 分支', () => {
  it('start→assign→finish：结算一次、passed 表达式生效、变量落值', async () => {
    const { host, state } = makeHost()
    const program = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_assign', kind: 'assign', target: 'v.score', value: { expr: 'v.score + 10' } },
        { id: 'f_finish', kind: 'finish', passed: 'v.score >= 10' },
      ],
      [out('f_start', 'f_assign'), out('f_assign', 'f_finish')],
    )
    const outcome = await run(program, { host, state })
    expect(outcome).toEqual({ kind: 'end', settled: true })
    expect(state.vars.score).toBe(10)
    expect(state.finished).toEqual([true])
  })

  it('finish 省略 passed 默认 true；重复 finish 幂等（仅首次生效）', async () => {
    const { host, state } = makeHost()
    const program = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_finish1', kind: 'finish' },
        { id: 'f_finish2', kind: 'finish', passed: 'false' },
      ],
      [out('f_start', 'f_finish1'), out('f_finish1', 'f_finish2')],
    )
    const outcome = await run(program, { host, state })
    expect(outcome).toEqual({ kind: 'end', settled: true })
    expect(state.finished).toEqual([true])
    expect(state.logs.some((l) => l.level === 'warning' && l.message.includes('finish 重复'))).toBe(true)
  })

  it('branch 双端口', async () => {
    const program = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_branch', kind: 'branch', cond: 'v.score > 0' },
        { id: 'f_yes', kind: 'finish', passed: 'true' },
        { id: 'f_no', kind: 'assign', target: 'v.score', value: { expr: '1' } },
      ],
      [
        out('f_start', 'f_branch'),
        out('f_branch', 'f_yes', 'true'),
        out('f_branch', 'f_no', 'false'),
        out('f_no', 'f_yes'),
      ],
    )
    const low = makeHost()
    const lowOutcome = await run(program, low)
    expect(lowOutcome).toEqual({ kind: 'end', settled: true })
    expect(low.state.vars.score).toBe(1)

    const high = makeHost()
    high.state.vars.score = 5
    await run(program, high)
    expect(high.state.finished).toEqual([true])
  })
})

describe('v4 flow：ask 调用协议', () => {
  it('ask 求值 target/args，结果写 local.<resultVar>，流程继续', async () => {
    const { host, state } = makeHost([{ status: 'answered', correct: true, scoreDelta: 10 }])
    const program = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', args: '{ difficulty: 2 }', resultVar: 'result' },
        { id: 'f_assign', kind: 'assign', target: 'v.score', value: { expr: 'v.score + local.result.scoreDelta' } },
        { id: 'f_finish', kind: 'finish', passed: 'local.result.correct' },
      ],
      [
        out('f_start', 'f_ask'),
        out('f_ask', 'f_assign'),
        out('f_assign', 'f_finish'),
      ],
    )
    const outcome = await run(program, { host, state })
    expect(outcome).toEqual({ kind: 'end', settled: true })
    expect(state.asks).toHaveLength(1)
    expect(state.asks[0].target).toEqual({ type: 'choice', row: 'row_01', slotIndex: 0 })
    expect(state.asks[0].args).toEqual({ difficulty: 2 })
    expect(state.vars.score).toBe(10)
    expect(state.finished).toEqual([true])
  })

  it('finish 之后 ask/assign 运行时报错（lint 之外的兜底）', async () => {
    for (const after of [
      { id: 'f_after', kind: 'ask' as const, target: 'run.questions[0]', resultVar: 'r' },
      { id: 'f_after', kind: 'assign' as const, target: 'v.score', value: { expr: '1' } },
    ]) {
      const { host, state } = makeHost()
      const program = flowProgram(
        [
          { id: 'f_start', kind: 'start' },
          { id: 'f_finish', kind: 'finish' },
          { ...after },
        ],
        [out('f_start', 'f_finish'), out('f_finish', 'f_after')],
      )
      const outcome = await run(program, { host, state })
      expect(outcome.kind).toBe('error')
      if (outcome.kind === 'error') expect(outcome.message).toContain('finish 之后')
      expect(state.finished).toEqual([true])
    }
  })

  it('restart：finish 前后都允许（finish 后 restart 是结算后重玩流程）', async () => {
    const before = makeHost()
    const programBefore = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_restart', kind: 'restart' },
      ],
      [out('f_start', 'f_restart')],
    )
    expect(await run(programBefore, before)).toEqual({ kind: 'restart' })

    const after = makeHost()
    const programAfter = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_finish', kind: 'finish' },
        { id: 'f_restart', kind: 'restart' },
      ],
      [out('f_start', 'f_finish'), out('f_finish', 'f_restart')],
    )
    expect(await run(programAfter, after)).toEqual({ kind: 'restart' })
    expect(after.state.finished).toEqual([true])
  })
})

describe('v4 flow：等待 / 视图 / 命令 / 未结算', () => {
  it('waitShell 与 setView / call', async () => {
    const { host, state } = makeHost()
    const program = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_view', kind: 'setView', view: 'play' },
        { id: 'f_call', kind: 'call', target: 'scoreLabel', method: 'setText', arg: "{text: 'hi'}" },
        { id: 'f_wait', kind: 'waitShell', event: 'scoreLabel.clicked' },
        { id: 'f_sleep', kind: 'wait', ms: '5' },
        { id: 'f_finish', kind: 'finish' },
      ],
      [
        out('f_start', 'f_view'),
        out('f_view', 'f_call'),
        out('f_call', 'f_wait'),
        out('f_wait', 'f_sleep'),
        out('f_sleep', 'f_finish'),
      ],
    )
    expect(await run(program, { host, state })).toEqual({ kind: 'end', settled: true })
    expect(state.views).toEqual(['play'])
    expect(state.commands).toEqual([{ target: 'scoreLabel', method: 'setText', arg: { text: 'hi' } }])
    expect(state.waits).toEqual(['scoreLabel.clicked'])
    expect(state.sleeps).toEqual([5])
  })

  it('自然结束未 finish → 未结算警告', async () => {
    const { host, state } = makeHost()
    const program = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_assign', kind: 'assign', target: 'v.score', value: { expr: '1' } },
      ],
      [out('f_start', 'f_assign')],
    )
    expect(await run(program, { host, state })).toEqual({ kind: 'end', settled: false })
    expect(state.logs.some((l) => l.level === 'warning' && l.message.includes('未结算'))).toBe(true)
  })
})

describe('v4 flow：foreach / loop', () => {
  it('foreach 遍历 run.questions，逐项 ask，结束 finish', async () => {
    const questions: Json[] = [
      { type: 'choice', row: 'row_01', slotIndex: 0 },
      { type: 'choice', row: 'row_02', slotIndex: 1 },
    ]
    const { host, state } = makeHost([], questions)
    const program = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_foreach', kind: 'foreach', items: 'run.questions', itemVar: 'slot', indexVar: 'i' },
        { id: 'f_ask', kind: 'ask', target: 'local.slot', resultVar: 'r' },
        { id: 'f_finish', kind: 'finish' },
      ],
      [
        out('f_start', 'f_foreach'),
        out('f_foreach', 'f_ask', 'true'),
        out('f_foreach', 'f_finish', 'false'),
        out('f_ask', 'f_foreach'),
      ],
    )
    expect(await run(program, { host, state })).toEqual({ kind: 'end', settled: true })
    expect(state.asks.map((a) => (a.target as { row: string }).row)).toEqual(['row_01', 'row_02'])
    expect(state.finished).toEqual([true])
  })

  it('loop repeat 指定次数；结束走 false 端口', async () => {
    const { host, state } = makeHost()
    const program = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_loop', kind: 'loop', mode: 'repeat', times: '2' },
        { id: 'f_inc', kind: 'assign', target: 'v.n', value: { expr: 'v.n + 1' } },
        { id: 'f_finish', kind: 'finish', passed: 'v.n == 2' },
      ],
      [
        out('f_start', 'f_loop'),
        out('f_loop', 'f_inc', 'true'),
        out('f_loop', 'f_finish', 'false'),
        out('f_inc', 'f_loop'),
      ],
    )
    expect(await run(program, { host, state })).toEqual({ kind: 'end', settled: true })
    expect(state.vars.n).toBe(2)
    expect(state.finished).toEqual([true])
  })
})

describe('v4 flow：异常 / 预算 / 取消', () => {
  it('预算超限 → error；预取消 → aborted；未知节点 → error', async () => {
    const budget = makeHost()
    const longProgram = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_a', kind: 'assign', target: 'v.score', value: { expr: '1' } },
        { id: 'f_finish', kind: 'finish' },
      ],
      [out('f_start', 'f_a'), out('f_a', 'f_finish')],
    )
    const budgetOutcome = await run(longProgram, budget, 2)
    expect(budgetOutcome.kind).toBe('error')
    if (budgetOutcome.kind === 'error') expect(budgetOutcome.message).toContain('预算')

    const cancel = new CancelToken()
    cancel.cancel()
    const aborted = await new FlowRunner(longProgram, budget.host, { cancel }).run()
    expect(aborted).toEqual({ kind: 'aborted' })

    const unknown = makeHost()
    const badProgram = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_bad', kind: 'teleport' } as unknown as FlowNode,
      ],
      [out('f_start', 'f_bad')],
    )
    const badOutcome = await run(badProgram, unknown)
    expect(badOutcome.kind).toBe('error')
    if (badOutcome.kind === 'error') expect(badOutcome.message).toContain('未知流程节点')
  })
})
