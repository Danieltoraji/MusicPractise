/** 图引擎调试门控（docs/30）：断点暂停/继续/单步语义 */
import { describe, expect, it } from 'vitest'
import type { Json } from './expr'
import { GraphEngine } from './graphEngine'
import type { GraphProgram } from './graphProgram'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

interface GateController {
  breakpoints: Set<string>
  pendingStep: boolean
  pausedAt: string | null
  resume(): void
  step(): void
  gate(nodeId: string, event: string): Promise<void>
}

function makeController(): GateController {
  const c = {
    breakpoints: new Set<string>(),
    pendingStep: false,
    pausedAt: null as string | null,
    resolvers: [] as Array<() => void>,
    resume() {
      c.pausedAt = null
      c.resolvers.splice(0).forEach((r) => r())
    },
    step() {
      c.pendingStep = true
      c.pausedAt = null
      c.resolvers.splice(0).forEach((r) => r())
    },
    gate(nodeId: string, _event: string): Promise<void> {
      if (!c.pendingStep && !c.breakpoints.has(nodeId)) return Promise.resolve()
      c.pendingStep = false
      c.pausedAt = nodeId
      return new Promise<void>((resolve) => {
        c.resolvers.push(() => resolve())
      })
    },
  }
  return c
}

function program(): GraphProgram {
  return {
    logicVersion: 2,
    variables: { score: 0 },
    nodes: [
      { id: 'on1', kind: 'on', event: 'test.go' },
      { id: 'a1', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' } },
      { id: 'a2', kind: 'assign', target: 'score', value: { expr: 'v.score + 10' } },
    ],
    edges: [
      { id: 'e1', from: 'on1', to: 'a1' },
      { id: 'e2', from: 'a1', to: 'a2' },
    ],
  }
}

function makeEngine(prog: ReturnType<typeof program>, ctrl: GateController) {
  const engine = new GraphEngine(prog, {
    getQuestion: () => null,
    dispatchCommand: () => {},
    debug: { gate: ctrl.gate },
  })
  return engine
}

describe('GraphEngine 调试门控（docs/30）', () => {
  it('断点：命中时挂起（变量可见），继续后走完', async () => {
    const ctrl = makeController()
    ctrl.breakpoints.add('a1')
    const engine = makeEngine(program(), ctrl)
    engine.dispatch('test.go')
    await flush()
    // 挂起在 a1：a1 尚未执行（score 仍 0），门控挂起中
    expect(ctrl.pausedAt).toBe('a1')
    expect(engine.vars.score).toBe(0)
    // 观察/赋值窗口：强设变量可见
    engine.vars.score = 50 as unknown as Json
    ctrl.resume()
    await flush()
    expect(ctrl.pausedAt).toBeNull()
    expect(engine.vars.score).toBe(61) // resume 后 a1(+1) → a2(+10)：50+1+10
  })

  it('单步：每次放行在下一节点边界重新暂停', async () => {
    const ctrl = makeController()
    ctrl.pendingStep = true
    const engine = makeEngine(program(), ctrl)
    engine.dispatch('test.go')
    await flush()
    expect(ctrl.pausedAt).toBe('a1')
    ctrl.step()
    await flush()
    expect(ctrl.pausedAt).toBe('a2')
    expect(engine.vars.score).toBe(1) // a1 已执行
    ctrl.step()
    await flush()
    expect(ctrl.pausedAt).toBeNull() // a2 是末节点，走完
    expect(engine.vars.score).toBe(11)
  })

  it('无断点：门控直通不挂起', async () => {
    const ctrl = makeController()
    const engine = makeEngine(program(), ctrl)
    engine.dispatch('test.go')
    await flush()
    expect(ctrl.pausedAt).toBeNull()
    expect(engine.vars.score).toBe(11)
  })
})
