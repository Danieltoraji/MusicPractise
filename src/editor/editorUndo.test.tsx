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

describe('编辑器撤销/重做（批次6c + docs/40 R3 历史纪律）', () => {
  // 单挂载内顺序验证（此环境下 EditorPage 重挂载 + useLiveQuery 组合不稳定）
  it('undo/redo 全语义：B1 连续输入合并为一条/新修改清重做栈/快捷键/输入框不拦截', async () => {
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
    await rename('第')
    await rename('第一版')
    await rename('第一版!')
    expect(title()).toBe('第一版!')

    // B1：一次连续输入（同 tag 逐键）在撤销栈中是一条——一次 undo 回到输入前
    const clickUndo = async (): Promise<void> => {
      await act(async () => undoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }
    const clickRedo = async (): Promise<void> => {
      await act(async () => redoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    }
    await clickUndo()
    expect(title()).toBe(initial)
    expect(undoBtn.disabled).toBe(true)
    await clickRedo()
    expect(title()).toBe('第一版!')
    expect(redoBtn.disabled).toBe(true)

    // 换操作（无 tag：加组件）打断合并——历史正确分段
    const addBtn = [...c.querySelectorAll('.palette button')].find((b) => b.textContent!.startsWith('+ '))!
    await act(async () => addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(c.querySelectorAll('.editor-box')).toHaveLength(1)
    await rename('第二版')
    await clickUndo()
    expect(title()).toBe('第一版!') // 撤销第二次输入段，组件保留
    await clickUndo()
    expect(c.querySelectorAll('.editor-box')).toHaveLength(0) // 撤销加组件
    expect(title()).toBe('第一版!')

    // undo 后新修改 → 清空重做栈
    await rename('第三版')
    expect(title()).toBe('第三版')
    expect(redoBtn.disabled).toBe(true)

    // 快捷键（非输入焦点）：Ctrl+Z 撤销 / Ctrl+Shift+Z 重做
    // 从内部元素冒泡（React 委托监听在 root 容器，事件需真实经过 DOM 树）
    const head = c.querySelector('.editor-head')!
    await act(async () => {
      head.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: 'z', bubbles: true }))
    })
    expect(title()).toBe('第一版!')
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

  it('R3：撤销回到保存基线自动清脏（不再要求重复保存）；再次编辑重新置脏', async () => {
    const c = renderEl(<EditorPage id="new" />)
    await flushUntil(() => c.querySelector('.editor-title') !== null)
    const saveBtn = [...c.querySelectorAll('.editor-head button')].find((b) => b.textContent?.includes('保存')) as HTMLButtonElement
    const title = c.querySelector('.editor-title') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    // 编辑 → 保存（基线确立）
    await act(async () => {
      setter.call(title, '基线版')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => saveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flushUntil(() => c.textContent!.includes('已保存'))
    expect(saveBtn.textContent).not.toContain(' *')
    // 再编辑（置脏）→ undo 回基线 → 脏标消失
    await act(async () => {
      setter.call(title, '基线版X')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(saveBtn.textContent).toContain(' *')
    const undoBtn = [...c.querySelectorAll('.editor-head button')].find((b) => b.textContent === '↶') as HTMLButtonElement
    await act(async () => undoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(saveBtn.textContent).not.toContain(' *') // 修复前：undo 恒 setDirty(true)，撤销到已保存态仍要求保存
    expect((c.querySelector('.editor-title') as HTMLInputElement).value).toBe('基线版')
  })

  it('B2 回归（§15.2 第 1 条反转）：60 步 pointermove 拖拽只有一条撤销步，一次 undo 整段回退', async () => {
    // jsdom 无指针捕获语义
    Element.prototype.setPointerCapture = (): void => {}
    Element.prototype.releasePointerCapture = (): void => {}
    const c = renderEl(<EditorPage id="new" />)
    await flushUntil(() => c.querySelector('.editor-title') !== null)
    // 加一个组件
    const addBtn = [...c.querySelectorAll('.palette button')].find((b) => b.textContent!.startsWith('+ '))!
    await act(async () => addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flushUntil(() => c.querySelectorAll('.editor-box').length === 1)
    const undoBtn = [...c.querySelectorAll('.editor-head button')].find((b) => b.textContent === '↶') as HTMLButtonElement
    expect(undoBtn.disabled).toBe(false)

    // pointerdown 选中 + 60 步 pointermove（每步位移触发 transient 更新）+ pointerup 落点提交
    const box = c.querySelector('.editor-box')!
    const before = (box as HTMLElement).style.left
    await act(async () => {
      box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3, clientX: 60, clientY: 60 }))
      for (let i = 1; i <= 60; i++) {
        box.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 3, clientX: 60 + i, clientY: 60 }))
      }
      box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 3 }))
    })
    await act(async () => {})
    expect(undoBtn.disabled).toBe(false)
    // 落点已提交（盒子位置变了）
    const after = (c.querySelector('.editor-box') as HTMLElement).style.left
    expect(after).not.toBe(before)
    // 一次 undo 整段回退到拖拽前位置（修复前 60 步 = 60 条历史，此前编辑被挤出栈）
    await act(async () => undoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect((c.querySelector('.editor-box') as HTMLElement).style.left).toBe(before)
    // 再 undo 回退加组件
    await act(async () => undoBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(c.querySelectorAll('.editor-box')).toHaveLength(0)
  })
})
