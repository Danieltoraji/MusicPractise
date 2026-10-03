// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../library/db'
import { EditorPage } from '../editor/EditorPage'

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

async function flushUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil 超时')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

beforeEach(async () => {
  window.location.hash = ''
  await db.resources.clear()
  await db.progress.clear()
})

afterEach(async () => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
  await db.resources.clear()
  window.location.hash = ''
})

describe('编辑器撤销/重做（批次6c）', () => {
  // 单挂载内顺序验证（此环境下 EditorPage 重挂载 + useLiveQuery 组合不稳定）
  it('undo/redo 全语义：回退/前进/栈底栈顶 disabled/新修改清重做栈/快捷键/输入框不拦截', async () => {
    const c = renderEl(<EditorPage id="new" />)
    await flushUntil(() => c.querySelector('.editor-title') !== null)
    const title = (): string => (c.querySelector('.editor-title') as HTMLInputElement).value
    const rename = async (name: string): Promise<void> => {
      await act(async () => {
        const input = c.querySelector('.editor-title') as HTMLInputElement
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, name)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }
    const undoBtn = [...c.querySelectorAll('.editor-head button')].find((b) => b.textContent === '↶') as HTMLButtonElement
    const redoBtn = [...c.querySelectorAll('.editor-head button')].find((b) => b.textContent === '↷') as HTMLButtonElement

    // 初始：双栈空
    expect(undoBtn.disabled).toBe(true)
    expect(redoBtn.disabled).toBe(true)

    const initial = title()
    await rename('第一版')
    await rename('第二版')
    expect(title()).toBe('第二版')

    const clickUndo = async (): Promise<void> => {
      await act(async () => undoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }
    const clickRedo = async (): Promise<void> => {
      await act(async () => redoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }

    await clickUndo()
    expect(title()).toBe('第一版')
    await clickUndo()
    expect(title()).toBe(initial)
    expect(undoBtn.disabled).toBe(true)
    await clickRedo()
    expect(title()).toBe('第一版')
    await clickRedo()
    expect(title()).toBe('第二版')
    expect(redoBtn.disabled).toBe(true)

    // undo 后新修改 → 清空重做栈
    await clickUndo()
    await rename('第三版')
    expect(title()).toBe('第三版')
    expect(redoBtn.disabled).toBe(true)

    // 快捷键（非输入焦点）：Ctrl+Z 撤销 / Ctrl+Shift+Z 重做
    // 从内部元素冒泡（React 委托监听在 root 容器，事件需真实经过 DOM 树）
    const head = c.querySelector('.editor-head')!
    await act(async () => {
      head.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'z', bubbles: true }))
    })
    expect(title()).toBe('第一版')
    await act(async () => {
      c.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'z', bubbles: true }))
    })
    expect(title()).toBe('第三版')

    // 输入框内 Ctrl+Z 不拦截（原生文本撤销优先）
    const input = c.querySelector('.editor-title') as HTMLInputElement
    const ev = new KeyboardEvent('keydown', { ctrlKey: true, key: 'z', bubbles: true, cancelable: true })
    input.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
  })
})
