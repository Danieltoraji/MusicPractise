import { afterEach, describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type { BehaviorNode, BehaviorProgram, FlowNode, GraphEdge, LevelDocV4 } from '../../engine/v4/model'
import { V4DebugController } from './debugRunV4'

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

function docWith(behaviorProgram: BehaviorProgram, flow: LevelDocV4['content']['flow']): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.types[0].behavior = behaviorProgram
  doc.content.flow = flow
  return doc
}

const instantCorrect = behavior(
  [
    { id: 'b_start', kind: 'on', event: 'start' },
    { id: 'b_ret', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }" },
  ],
  [out('b_start', 'b_ret')],
)

const waitForEvent = behavior(
  [
    { id: 'b_start', kind: 'on', event: 'start' },
    { id: 'b_on', kind: 'on', event: 'choice1.chosen' },
    { id: 'b_ret', kind: 'return', result: "{ scoreDelta: event.payload.score }" },
  ],
  [out('b_on', 'b_ret')],
)

const simpleFlow = flowProgram(
  [
    { id: 'f_start', kind: 'start' },
    { id: 'f_a1', kind: 'assign', target: 'v.score', value: { expr: 'v.score + 1' } },
    { id: 'f_a2', kind: 'assign', target: 'v.score', value: { expr: 'v.score + 1' } },
    { id: 'f_finish', kind: 'finish', passed: 'v.score >= 2' },
  ],
  [out('f_start', 'f_a1'), out('f_a1', 'f_a2'), out('f_a2', 'f_finish')],
)

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 3))
  }
  throw new Error(`等待超时：${label}`)
}

const controllers: V4DebugController[] = []
function track(controller: V4DebugController): V4DebugController {
  controllers.push(controller)
  return controller
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop()
})

describe('v4 调试运行：flow 断点/单步', () => {
  it('断点按节点暂停；step 到下一节点；resume 跑到结算', async () => {
    const controller = track(new V4DebugController(docWith(instantCorrect, simpleFlow)))
    controller.setBreakpoints([{ kind: 'flow', nodeId: 'f_a1' }])
    controller.start()
    await waitFor(() => controller.getSnapshot().paused, '暂停在 f_a1')
    expect(controller.getSnapshot().pausedAt).toEqual({ kind: 'flow', nodeId: 'f_a1' })
    expect(controller.getSnapshot().state.scopes.v.score).toBe(0)

    // step：放行 f_a1，在 f_a2 再次暂停（pauseNext 语义）
    controller.step()
    await waitFor(() => controller.getSnapshot().pausedAt?.nodeId === 'f_a2', '暂停在 f_a2')
    expect(controller.getSnapshot().state.scopes.v.score).toBe(1)

    controller.resume()
    await waitFor(() => controller.getSnapshot().session.result !== null, '结算')
    expect(controller.getSnapshot().session.result).toEqual({ score: 2, passed: true })
    expect(controller.getSnapshot().paused).toBe(false)
  })

  it('pause() 无断点也可在下一节点边界暂停', async () => {
    const controller = track(new V4DebugController(docWith(instantCorrect, simpleFlow)))
    controller.start()
    controller.pause()
    await waitFor(() => controller.getSnapshot().paused, '暂停')
    const at = controller.getSnapshot().pausedAt
    expect(at?.kind).toBe('flow')
    controller.resume()
    await waitFor(() => controller.getSnapshot().session.result !== null, '结算')
  })

  it('setBreakpoints 整体替换；toggleBreakpoint 可开关', () => {
    const controller = track(new V4DebugController(docWith(instantCorrect, simpleFlow)))
    controller.setBreakpoints([{ kind: 'flow', nodeId: 'f_a1' }])
    expect(controller.hasBreakpoint('flow', 'f_a1')).toBe(true)
    expect(controller.hasBreakpoint('flow', 'f_a2')).toBe(false)
    controller.setBreakpoints([{ kind: 'flow', nodeId: 'f_a2' }])
    expect(controller.hasBreakpoint('flow', 'f_a1')).toBe(false)
    expect(controller.hasBreakpoint('flow', 'f_a2')).toBe(true)
    expect(controller.toggleBreakpoint('flow', 'f_a2')).toBe(false)
    expect(controller.hasBreakpoint('flow', 'f_a2')).toBe(false)
  })
})

describe('v4 调试运行：behavior 断点 + 停止', () => {
  it('behavior 断点在题型行为节点暂停，resume 后返回结算', async () => {
    const flow = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'local.r.scoreDelta' } },
        { id: 'f_finish', kind: 'finish', passed: 'v.score >= 5' },
      ],
      [out('f_start', 'f_ask'), out('f_ask', 'f_apply'), out('f_apply', 'f_finish')],
    )
    const controller = track(new V4DebugController(docWith(waitForEvent, flow)))
    controller.setBreakpoints([{ kind: 'behavior', nodeId: 'b_ret' }])
    controller.start()
    await waitFor(() => controller.getSnapshot().session.surface !== null, '挂载 surface')
    controller.session.dispatchSurfaceEvent('choice1', 'chosen', { score: 6 })
    await waitFor(() => controller.getSnapshot().paused, '暂停在 b_ret')
    expect(controller.getSnapshot().pausedAt).toEqual({ kind: 'behavior', nodeId: 'b_ret' })
    expect(controller.getSnapshot().state.callStack.map((frame) => frame.kind)).toEqual(['flow', 'behavior'])
    controller.resume()
    await waitFor(() => controller.getSnapshot().session.result !== null, '结算')
    expect(controller.getSnapshot().session.result).toEqual({ score: 6, passed: true })
  })

  it('暂停中 stop() 不会死锁：放行门控并销毁会话', async () => {
    const controller = new V4DebugController(docWith(instantCorrect, simpleFlow))
    controller.setBreakpoints([{ kind: 'flow', nodeId: 'f_a1' }])
    controller.start()
    await waitFor(() => controller.getSnapshot().paused, '暂停在 f_a1')
    controller.stop()
    expect(controller.getSnapshot().running).toBe(false)
    expect(controller.getSnapshot().paused).toBe(false)
  })
})
