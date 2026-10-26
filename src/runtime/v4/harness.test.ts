import { describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type { BehaviorNode, BehaviorProgram, FlowNode, GraphEdge, LevelDocV4 } from '../../engine/v4/model'
import { runLevelHeadless } from './harness'

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

const askAllFlow = flowProgram(
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

const interactFlow = flowProgram(
  [
    { id: 'f_start', kind: 'start' },
    { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
    { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'local.r.scoreDelta' } },
    { id: 'f_finish', kind: 'finish', passed: 'v.score >= 7' },
  ],
  [out('f_start', 'f_ask'), out('f_ask', 'f_apply'), out('f_apply', 'f_finish')],
)

describe('v4 harness：无头通关', () => {
  it('自动牌堆 2 行 → 逐题返回 → score/passed/每题记录齐全', async () => {
    const report = await runLevelHeadless(docWith(instantCorrect, askAllFlow))
    expect(report.ok).toBe(true)
    expect(report.finished).toBe(true)
    expect(report.result).toEqual({ score: 20, passed: true })
    expect(report.questions).toHaveLength(2)
    expect(report.questions.map((q) => q.rowId)).toEqual(['row_01', 'row_02'])
    expect(report.questions[0].result).toMatchObject({ status: 'answered', scoreDelta: 10 })
    expect(report.deck).toHaveLength(2)
  })

  it('固定 seed 可复现（同 seed 同牌堆/seed 记录）', async () => {
    const a = await runLevelHeadless(docWith(instantCorrect, askAllFlow), { seed: 7 })
    const b = await runLevelHeadless(docWith(instantCorrect, askAllFlow), { seed: 7 })
    expect(a.seed).toBe(7)
    expect(a.deck).toEqual(b.deck)
    expect(a.questions.map((q) => q.rowId)).toEqual(b.questions.map((q) => q.rowId))
  })

  it('剧本注入 surface 事件后完成交互题', async () => {
    const report = await runLevelHeadless(docWith(waitForEvent, interactFlow), {
      script: [{ when: 'surface', action: { kind: 'surface', component: 'choice1', event: 'chosen', payload: { score: 7 } } }],
    })
    expect(report.ok).toBe(true)
    expect(report.result).toEqual({ score: 7, passed: true })
    expect(report.lastResult).toMatchObject({ status: 'answered', scoreDelta: 7 })
  })
})

describe('v4 harness：超时 / 等待 shell', () => {
  it('流程卡住（题目永不返回且无剧本）→ 报超时错误', async () => {
    const stuck = behavior(
      [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_wait', kind: 'wait', ms: '5000' },
        { id: 'b_ret', kind: 'return', result: '{}' },
      ],
      [out('b_start', 'b_wait'), out('b_wait', 'b_ret')],
    )
    const report = await runLevelHeadless(docWith(stuck, interactFlow), { timeoutMs: 120 })
    expect(report.ok).toBe(false)
    expect(report.finished).toBe(false)
    expect(report.error).toMatch(/未结束/)
  })

  it('剧本等待 shellWait 并注入 shell 事件', async () => {
    const shellFlow = flowProgram(
      [
        { id: 'f_start', kind: 'start' },
        { id: 'f_ask', kind: 'ask', target: 'run.questions[0]', resultVar: 'r' },
        { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'local.r.scoreDelta' } },
        { id: 'f_finish', kind: 'finish', passed: 'v.score >= 7' },
        { id: 'f_wait', kind: 'waitShell', event: 'scoreLabel.clicked' },
      ],
      [
        out('f_start', 'f_ask'),
        out('f_ask', 'f_apply'),
        out('f_apply', 'f_finish'),
        out('f_finish', 'f_wait'),
      ],
    )
    const report = await runLevelHeadless(docWith(waitForEvent, shellFlow), {
      script: [
        { when: 'surface', action: { kind: 'surface', component: 'choice1', event: 'chosen', payload: { score: 7 } } },
        { when: 'shellWait', action: { kind: 'shell', component: 'scoreLabel', event: 'clicked' } },
      ],
    })
    expect(report.ok).toBe(true)
    expect(report.result).toEqual({ score: 7, passed: true })
    expect(report.finished).toBe(true)
  })
})
