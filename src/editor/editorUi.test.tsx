// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { LevelDoc } from '../engine/level'
import { checkExprText } from './EditorPage'
import { TableEditor } from './TableGrid'

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
  it('渲染数据表网格：列头（列名/类型）与行头（题号）', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    act(() => {
      root = createRoot(container)
      root.render(<TableEditor doc={baseDoc()} onChange={() => {}} />)
    })
    try {
      expect(container.textContent).toContain('题目数据表')
      // 网格：行头题号 1（= v.__row 值）、列类型下拉、单元格输入
      expect(container.querySelectorAll('.tgrid tbody tr').length).toBeGreaterThanOrEqual(1)
      expect(container.querySelectorAll('.tgrid-type').length).toBeGreaterThanOrEqual(1)
      expect(container.querySelector('.tgrid-rownum')?.textContent).toBe('1')
      expect(container.querySelectorAll('input').length).toBeGreaterThanOrEqual(3)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('notes 列单元格渲染音符 chips；类型切换与单元格提交走 onChange', () => {
    const doc = baseDoc()
    doc.content.table = {
      columns: [
        { key: 'title', label: '题面', type: 'text' },
        { key: 'notes', label: '示例音符', type: 'notes' },
        { key: 'locked', label: '是否加锁', type: 'boolean' },
      ],
      rows: [{ title: '行一', notes: [{ midi: 60, dur: '4n' }], locked: false }],
    }
    let current = doc
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const rerender = (): void => {
      act(() => root.render(<TableEditor doc={current} onChange={(n) => { current = n }} />))
    }
    act(() => {
      root = createRoot(container)
      rerender()
    })
    try {
      // notes 单元格：结构化 chips（音名下拉），不出现 JSON 文本
      const noteCell = container.querySelector('.tcell-notes')!
      expect(noteCell.querySelectorAll('.play-note').length).toBeGreaterThanOrEqual(1)
      expect(noteCell.textContent).not.toContain('midi')
      // 文本单元格：输入即提交（受控写回）
      const textInput = container.querySelector('.tcell-text .tgrid-input') as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      act(() => {
        setter.call(textInput, '改过的题面')
        textInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      expect(current.content.table.rows[0].title).toBe('改过的题面')
      // 布尔单元格：勾选提交
      const checkbox = container.querySelector('.tcell-boolean input') as HTMLInputElement
      act(() => {
        checkbox.click()
      })
      expect(current.content.table.rows[0].locked).toBe(true)
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
