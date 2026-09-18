// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LevelDoc } from '../engine/level'
import { checkExprText, RulesEditor } from './EditorPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const containers: HTMLElement[] = []
const roots: Root[] = []

function renderEl(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  containers.push(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  roots.push(root)
  return container
}

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

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
      variables: { score: 0 },
      rules: [{ id: 'r1', on: 'staff1.noteClicked', do: [{ set: 'score', expr: 'v.score + 1' }] }],
    },
    questions: [{ id: 'q1', data: {}, scoring: { max: 10 } }],
    flow: {},
  },
})

describe('RulesEditor（jsdom 渲染）', () => {
  it('渲染规则卡片、变量表与表达式建议 datalist', () => {
    const container = renderEl(<RulesEditor doc={baseDoc()} onChange={() => {}} />)
    expect(container.querySelectorAll('.rule-card')).toHaveLength(1)
    expect(container.querySelectorAll('.var-row')).toHaveLength(1)
    expect(container.querySelector('#expr-options')).not.toBeNull()
  })

  it('添加规则按钮增加规则卡片（受控回写）', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<RulesEditor doc={doc} onChange={onChange} />)
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('添加规则'))!
    act(() => btn.click())
    expect(doc.content.logic.rules).toHaveLength(2)
  })

  it('LinesField：非法表达式实时报错，修正后消失', () => {
    const container = renderEl(<RulesEditor doc={baseDoc()} onChange={() => {}} />)
    const linesField = container.querySelector('.rule-card textarea')!
    expect(linesField).not.toBeNull()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(linesField, 'v.score +\n')
      linesField.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('第 1 行')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(linesField, 'v.score + 1')
      linesField.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('.tone-error')).toBeNull()
  })
})

describe('checkExprText（表达式实时校验）', () => {
  it('合法表达式返回 null', () => {
    expect(checkExprText('v.score + 1')).toBeNull()
    expect(checkExprText('')).toBeNull()
  })
  it('语法错误返回消息', () => {
    expect(checkExprText('v.score +')).not.toBeNull()
  })
})
