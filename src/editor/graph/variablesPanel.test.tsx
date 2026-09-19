// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphProgram } from '../../engine/graphProgram'
import { VariablesPanel } from './VariablesPanel'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

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

const prog = (): GraphProgram => ({
  logicVersion: 2,
  variables: { score: 0, taps: [] as unknown as never[] },
  nodes: [],
  edges: [],
})

function findRow(container: HTMLElement, name: string): { row: HTMLElement; nameInput: HTMLInputElement; valueInput: HTMLInputElement } | null {
  const rows = [...container.querySelectorAll('.gvar-row')]
  for (const row of rows) {
    const nameInput = row.querySelector('.gvar-name') as HTMLInputElement
    if (nameInput && nameInput.value === name) {
      const valueInput = row.querySelector('.gvar-value') as HTMLInputElement
      return { row: row as HTMLElement, nameInput, valueInput }
    }
  }
  return null
}

describe('VariablesPanel（jsdom）', () => {
  it('P1-1 回归：值未变更失焦为 no-op（数组初值不被启发式解析毁成字符串）', () => {
    const onSet = vi.fn(() => true)
    const container = renderEl(<VariablesPanel prog={prog()} onSet={onSet} onRename={() => true} onRemove={() => true} />)
    const row = findRow(container, 'taps')!
    expect(row).toBeTruthy()
    expect(row.valueInput.value).toBe('[]')
    // 未做任何修改，直接失焦
    act(() => {
      row.valueInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onSet).not.toHaveBeenCalled()
  })

  it('P1-1 回归：[/ { 开头按 JSON 解析；JSON 失败还原输入', () => {
    const onSet = vi.fn(() => true)
    const container = renderEl(
      <VariablesPanel prog={prog()} onSet={onSet} onRename={() => true} onRemove={() => true} />,
    )
    const row = findRow(container, 'score')!
    // 合法 JSON 数组
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(row.valueInput, '[60, 64]')
      row.valueInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      row.valueInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onSet).toHaveBeenCalledWith('score', [60, 64])
    // 非法 JSON：还原输入框
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(row.valueInput, '[broken')
      row.valueInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      row.valueInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    // onSet 是 mock（不回写 prog）：组件还原到 props 里的当前值 0
    expect((row.valueInput as HTMLInputElement).value).toBe('0')
  })

  it('P1-2 回归：改名失败（非法/撞名）输入框还原', () => {
    const onRename = vi.fn((_oldName: string, newName: string) => newName !== 'taps') // 撞 taps 失败
    const container = renderEl(<VariablesPanel prog={prog()} onSet={() => true} onRename={onRename} onRemove={() => true} />)
    const row = findRow(container, 'score')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(row.nameInput, 'taps')
      row.nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      row.nameInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onRename).toHaveBeenCalledWith('score', 'taps')
    expect((row.nameInput as HTMLInputElement).value).toBe('score') // 已还原
  })

  it('添加变量：重名自动后缀', () => {
    const onSet = vi.fn(() => true)
    const container = renderEl(<VariablesPanel prog={prog()} onSet={onSet} onRename={() => true} onRemove={() => true} />)
    const input = container.querySelector('.gvar-add input') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'taps')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const addBtn = [...container.querySelectorAll('.gvar-add button')].find((b) => b.textContent?.includes('添加'))!
    act(() => (addBtn as HTMLElement).click())
    expect(onSet).toHaveBeenCalledWith('taps2', 0)
  })
})
