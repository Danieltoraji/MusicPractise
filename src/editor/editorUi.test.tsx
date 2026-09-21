// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { LevelDoc } from '../engine/level'
import { checkExprText, TableEditor } from './EditorPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const baseDoc = (): LevelDoc => ({
  schemaVersion: 3,
  kind: 'level',
  id: 'res_01J9A0A0A0A0A0A0A0A0A0A0A1',
  version: '0.1.0',
  meta: { title: '编辑器测试' },
  refs: [],
  content: {
    views: [{ id: 'main', name: '主视图' }],
    components: [{ id: 'staff1', type: 'staff', visible: true, view: 'main' }],
    logic: {
      logicVersion: 2,
      variables: { score: 0 },
      nodes: [
        { id: 'on_click', kind: 'on', event: 'staff1.noteClicked' },
        { id: 'add', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' } },
      ],
      edges: [{ id: 'e1', from: 'on_click', to: 'add' }],
    },
    table: {
      columns: [
        { key: 'data', label: '数据' },
        { key: 'scoring', label: '分值' },
      ],
      rows: [{ data: { a: 1 }, scoring: { max: 10 } }],
    },
    flow: {},
  },
})

describe('TableEditor（jsdom 渲染）', () => {
  it('渲染数据表的列头与行卡片', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    act(() => {
      root = createRoot(container)
      root.render(<TableEditor doc={baseDoc()} onChange={() => {}} />)
    })
    try {
      expect(container.textContent).toContain('题目数据表')
      expect(container.textContent).toContain('第 1 行')
      expect(container.querySelectorAll('input').length).toBeGreaterThanOrEqual(3)
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
