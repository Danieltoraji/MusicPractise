// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { LogicProgram } from '../engine/logic'
import { exprReadVars, programToGraph } from './programToGraph'

const program = (): LogicProgram => ({
  variables: { score: 0, taps: [] },
  rules: [
    {
      id: 'check',
      on: 'staff1.noteClicked',
      when: ['event.midi == q.data.answerMidi', 'v.streak == 0'],
      do: [
        { cmd: 'sound1.play', args: { notes: '$q.data.reward' } },
        { set: 'score', expr: 'v.score + 10' },
        { emit: 'level:correct', payload: {} },
      ],
      else: [{ set: 'score', expr: 'v.score - 1' }],
    },
    {
      id: 'reward',
      on: 'level:correct',
      do: [{ emit: 'ui.flash', payload: {} }],
    },
    {
      id: 'orphan',
      on: 'nothing.here',
      do: [{ set: 'score', expr: 'v.score + 5' }],
    },
  ],
})

describe('programToGraph', () => {
  it('变量节点覆盖所有声明变量', () => {
    const g = programToGraph(program())
    const varNodes = g.nodes.filter((n) => n.kind === 'var')
    expect(varNodes.map((n) => n.label)).toContain('v.score')
    expect(varNodes.map((n) => n.label)).toContain('v.taps')
  })

  it('事件节点按 on 去重', () => {
    const g = programToGraph(program())
    const events = g.nodes.filter((n) => n.kind === 'event').map((n) => n.label)
    expect(events).toHaveLength(3) // staff1.noteClicked / level:correct / nothing.here
  })

  it('规则节点每条规则一个', () => {
    const g = programToGraph(program())
    expect(g.nodes.filter((n) => n.kind === 'rule')).toHaveLength(3)
  })

  it('do/else 动作各自成节点，else 带标注', () => {
    const g = programToGraph(program())
    const actions = g.nodes.filter((n) => n.kind === 'action')
    // check: 3 do + 1 else；reward: 1；orphan: 1 → 6
    expect(actions).toHaveLength(6)
    expect(g.edges.some((e) => e.label === '否则')).toBe(true)
  })

  it('emit 动作产生到目标事件节点的触发边', () => {
    const g = programToGraph(program())
    const trigger = g.edges.find((e) => e.kind === 'trigger')
    expect(trigger).toBeDefined()
    expect(trigger!.target).toBe('event:level:correct')
  })

  it('set 动作产生写入边（仅指向已声明变量）', () => {
    const g = programToGraph(program())
    const writes = g.edges.filter((e) => e.kind === 'write')
    expect(writes.length).toBeGreaterThanOrEqual(3)
    expect(writes.every((e) => e.target.startsWith('var:'))).toBe(true)
  })

  it('when 中读取的变量产生读取边', () => {
    const g = programToGraph(program())
    const reads = g.edges.filter((e) => e.kind === 'read')
    expect(reads.length).toBeGreaterThanOrEqual(1)
  })

  it('触发环（E1→E2→E1）不产生悬空边也不死循环', () => {
    const cyclic: LogicProgram = {
      rules: [
        { id: 'a', on: 'e1', do: [{ emit: 'e2' }] },
        { id: 'b', on: 'e2', do: [{ emit: 'e1' }] },
      ],
    }
    const g = programToGraph(cyclic)
    expect(g.nodes.filter((n) => n.kind === 'event')).toHaveLength(2)
    expect(g.edges.filter((e) => e.kind === 'trigger')).toHaveLength(2)
  })

  it('exprReadVars 提取 v.x 引用', () => {
    expect(exprReadVars('v.score + q.scoring.max')).toEqual(['score'])
    expect(exprReadVars('v.a + v.b_1')).toEqual(['a', 'b_1'])
    expect(exprReadVars('no vars')).toEqual([])
  })
})
