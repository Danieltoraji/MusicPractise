// 节点卡中文摘要单测（summary.ts 纯函数）
import { describe, expect, it } from 'vitest'
import { friendlyEvent, summarizeNode, type CompInfo } from './summary'

const comps: CompInfo[] = [
  { id: 'btn1', name: '开始按钮', type: 'button' },
  { id: 'sound1', type: 'sound' },
]

describe('friendlyEvent', () => {
  it('生命周期事件翻译', () => {
    expect(friendlyEvent('level.started')).toBe('关卡开始')
    expect(friendlyEvent('question.loaded')).toBe('题目载入')
    expect(friendlyEvent('level.finished')).toBe('关卡结算')
  })

  it('组件事件：友好名 + 尾部词翻译；未收录回退原文', () => {
    expect(friendlyEvent('btn1.clicked', comps)).toBe('开始按钮·被点击')
    expect(friendlyEvent('sound1.roundDone', comps)).toBe('sound1·一轮结束')
    expect(friendlyEvent('app:burst', comps)).toBe('app:burst')
    expect(friendlyEvent('ghost1.whatever', comps)).toBe('ghost1·whatever')
  })
})

describe('summarizeNode', () => {
  it('on / call / assign / branch', () => {
    expect(summarizeNode({ id: 'a', kind: 'on', event: 'btn1.clicked' }, comps)).toEqual(['当 开始按钮·被点击'])
    expect(summarizeNode({ id: 'b', kind: 'call', target: 'sound1', method: 'play', args: ["{notes: q.data.x}"] }, comps)).toEqual([
      'sound1·play { notes }',
    ])
    expect(summarizeNode({ id: 'c', kind: 'call', target: 'question', method: 'next', args: [] }, comps)).toEqual(['question·next'])
    expect(summarizeNode({ id: 'd', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' } }, comps)).toEqual([
      'v.score = v.score + 1',
    ])
    expect(
      summarizeNode({ id: 'e', kind: 'assign', target: 'val', value: { call: { target: 'slider1', method: 'getValue', args: [] } } }, comps),
    ).toEqual(['v.val = slider1·getValue()'])
    expect(summarizeNode({ id: 'f', kind: 'branch', cond: 'v.score >= 10' }, comps)).toEqual(['如果 v.score >= 10'])
  })

  it('loop / wait / emit / comment', () => {
    expect(summarizeNode({ id: 'a', kind: 'loop', mode: 'repeat', times: '3' }, comps)).toEqual(['重复 3 次'])
    expect(summarizeNode({ id: 'b', kind: 'loop', mode: 'while', cond: 'v.i < 3' }, comps)).toEqual(['只要 v.i < 3 就循环'])
    expect(summarizeNode({ id: 'c', kind: 'wait', ms: '500' }, comps)).toEqual(['等待 500 毫秒'])
    expect(summarizeNode({ id: 'd', kind: 'emit', event: 'app:burst', payload: { n: '1' } }, comps)).toEqual([
      '触发 app:burst',
      '{ n }',
    ])
    expect(summarizeNode({ id: 'e', kind: 'comment', text: '备注' }, comps)).toEqual(['备注'])
  })

  it('未知实例 id 原样显示（不猜名字）', () => {
    expect(summarizeNode({ id: 'x', kind: 'call', target: 'ghost', method: 'stop', args: [] }, comps)).toEqual(['ghost·stop'])
  })
})
