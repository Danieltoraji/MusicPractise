// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { LevelDoc } from '../engine/level'
import { checkExprText, QuestionsEditor } from './EditorPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseDoc = (): LevelDoc => ({
  schemaVersion: 1,
  kind: 'level',
  id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A1',
  version: '0.1.0',
  meta: { title: '编辑器测试' },
  refs: [],
  content: {
    components: [{ id: 'staff1', type: 'staff', visible: true }],
    logic: {
      logicVersion: 2,
      variables: { score: 0 },
      nodes: [
        { id: 'on_click', kind: 'on', event: 'staff1.noteClicked' },
        { id: 'add', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' } },
      ],
      edges: [{ id: 'e1', from: 'on_click', to: 'add' }],
    },
    questions: [
      { id: 'q1', data: { a: 1 }, scoring: { max: 10 } },
    ],
    flow: {},
  },
})

describe('QuestionsEditor（jsdom 渲染）', () => {
  it('渲染题目卡片与 data JSON 输入', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    act(() => {
      root = createRoot(container)
      root.render(<QuestionsEditor doc={baseDoc()} onChange={() => {}} />)
    })
    try {
      expect(container.textContent).toContain('q1')
      expect(container.querySelectorAll('textarea').length).toBeGreaterThanOrEqual(1)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})

describe('checkExprText（表达式实时校验）', () => {
  it('合法表达式返回 null', () => {
    expect(checkExprText('v.score + 1')).toBeNull()
    expect(checkExprText('')).toBeNull()
    expect(checkExprText('{notes: [{midi: 60}]}')).toBeNull()
  })
  it('语法错误返回消息', () => {
    expect(checkExprText('v.score +')).not.toBeNull()
  })
})
