// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LevelDoc } from '../../engine/level'
import { GraphEditor } from './GraphEditor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// React Flow 依赖 ResizeObserver（jsdom 无）
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1200 })
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 700 })
})

const containers: HTMLElement[] = []
const roots: Root[] = []

function renderEl(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  containers.push(container)
  roots.push(root)
  return container
}

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

const baseDoc = (): LevelDoc =>
  ({
    schemaVersion: 1,
    kind: 'level',
    id: 'res_x',
    version: '0.1.0',
    meta: { title: '节点图测试' },
    refs: [],
    content: {
      components: [{ id: 'sound1', type: 'sound', visible: false }],
      logic: {
        logicVersion: 2,
        variables: { score: 0 },
        nodes: [
          { id: 'on1', kind: 'on', event: 'level.started', x: 0, y: 0 },
          { id: 'as1', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' }, x: 300, y: 0 },
        ],
        edges: [{ id: 'e1', from: 'on1', to: 'as1' }],
      },
      questions: [{ id: 'q1', data: {}, scoring: { max: 10 } }],
      flow: {},
    },
  }) as unknown as LevelDoc

describe('GraphEditor（jsdom 冒烟）', () => {
  it('渲染节点信息卡（参数摘要印卡）与节点库分组', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} />)
    expect(container.textContent).toContain('事件')
    expect(container.textContent).toContain('v.score = v.score + 1')
    expect(container.textContent).toContain('level.started')
    expect(container.textContent).toContain('节点库')
    expect(container.textContent).toContain('实例动作')
  })

  it('点击节点库项添加节点（受控回写）', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} />)
    const addBtn = [...container.querySelectorAll('.glib-item')].find((b) => b.textContent?.includes('进入下一题'))!
    act(() => (addBtn as HTMLElement).click())
    expect(doc.content.logic.nodes).toHaveLength(3)
    const added = doc.content.logic.nodes.find((n) => n.kind === 'call')
    expect(added).toMatchObject({ target: 'level', method: 'next', args: [] })
  })

  it('Inspector 编辑 branch 条件并回写', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    // 初始带一个 branch 节点并预选中
    doc = {
      ...doc,
      content: {
        ...doc.content,
        logic: {
          ...doc.content.logic,
          nodes: [...doc.content.logic.nodes, { id: 'br1', kind: 'branch', cond: 'true', x: 600, y: 0 }],
        },
      },
    }
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} />)
    // 模拟选中：直接操作 Inspector 需要选中态——通过渲染时 doc 已含 br1，点击节点卡
    const card = [...container.querySelectorAll('.gnode')].find((el) => el.textContent?.includes('if (true)'))
    expect(card).toBeTruthy()
    act(() => card!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // Inspector 显示条件输入框
    const input = [...container.querySelectorAll('.ginsp input')].find((el) => (el as HTMLInputElement).value === 'true')
    expect(input).toBeTruthy()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'v.score >= 10')
      input!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // 应用条件按钮（失焦提交模式）
    const applyBtn = [...container.querySelectorAll('.ginsp button')].find((b) => b.textContent === '应用条件')!
    act(() => (applyBtn as HTMLElement).click())
    const patched = doc.content.logic.nodes.find((n) => n.id === 'br1')
    expect(patched).toMatchObject({ kind: 'branch', cond: 'v.score >= 10' })
  })
})
