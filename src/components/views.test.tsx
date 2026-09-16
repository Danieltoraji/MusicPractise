// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInstance } from '../engine/level'
import { ComponentStore } from '../runtime/store'
import { ButtonView, ChoiceView, StaffView } from './views'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

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

describe('组件视图（jsdom 冒烟）', () => {
  it('StaffView 渲染 SVG 并按顺序挂 data-midi', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = {
      id: 'staff1',
      type: 'staff',
      layout: { x: 0, y: 0, w: 720, h: 160 },
      props: { clickable: true },
    }
    store.init([spec])
    store.applyBinding('staff1', 'music', { notes: [{ midi: 60 }, { midi: 64 }], clef: 'treble' })
    const container = renderEl(<StaffView spec={spec} store={store} emit={() => {}} />)
    const groups = container.querySelectorAll('[data-midi]')
    expect([...groups].map((g) => g.getAttribute('data-midi'))).toEqual(['60', '64'])
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('ChoiceView 点击发 chosen；reveal 后锁定并标记对错', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'choice1', type: 'choice', layout: { x: 0, y: 0, w: 720, h: 220 } }
    store.init([spec])
    store.applyBinding('choice1', 'options', ['甲', '乙', '丙'])
    const emit = vi.fn()
    const container = renderEl(<ChoiceView spec={spec} store={store} emit={emit} />)

    const items = container.querySelectorAll('.choice-item')
    expect(items).toHaveLength(3)
    act(() => {
      ;(items[1] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(emit).toHaveBeenCalledWith('chosen', { index: 1, value: '乙' })

    act(() => {
      store.applyCommand('choice1', 'reveal', { correctIndex: 2 })
    })
    const after = container.querySelectorAll('.choice-item')
    expect(after[2].className).toContain('is-correct')
    expect(after[1].className).toContain('is-wrong')
    expect((after[0] as HTMLButtonElement).disabled).toBe(true)
  })

  it('ChoiceView 换题（options 更新）清除已锁定状态', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'choice1', type: 'choice', layout: { x: 0, y: 0, w: 720, h: 220 } }
    store.init([spec])
    store.applyBinding('choice1', 'options', ['A', 'B'])
    const container = renderEl(<ChoiceView spec={spec} store={store} emit={() => {}} />)
    act(() => {
      store.applyCommand('choice1', 'reveal', { correctIndex: 0 })
    })
    expect((container.querySelector('.choice-item') as HTMLButtonElement).disabled).toBe(true)

    act(() => {
      store.applyBinding('choice1', 'options', ['X', 'Y', 'Z'])
    })
    const renewed = container.querySelectorAll('.choice-item')
    expect(renewed).toHaveLength(3)
    expect((renewed[0] as HTMLButtonElement).disabled).toBe(false)
  })

  it('ButtonView 禁用时不发 clicked，启用后可发', () => {
    const store = new ComponentStore()
    const spec: ComponentInstance = { id: 'b1', type: 'button', layout: { x: 0, y: 0, w: 140, h: 48 }, props: { text: 'go', enabled: false } }
    store.init([spec])
    const emit = vi.fn()
    const container = renderEl(<ButtonView spec={spec} store={store} emit={emit} />)

    const btn = container.querySelector('button') as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(emit).not.toHaveBeenCalled()

    act(() => {
      store.applyCommand('b1', 'setEnabled', { enabled: true })
    })
    act(() => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(emit).toHaveBeenCalledWith('clicked')
  })
})
