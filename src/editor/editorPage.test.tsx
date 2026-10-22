// @vitest-environment jsdom
// EditorPage 保存回归：同一编辑会话可连续保存多次（防重入标记 try/finally 释放——
// 此前 savingRef 置 true 后从未复位，首次保存后「保存/试运行」整会话失效）
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../library/db'
import { blankLevelDoc } from './docState'
import { EditorPage } from './EditorPage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DOC_ID = 'res_01J9E000000000000000000000'

let root: Root | null = null
let container: HTMLElement | null = null

/** 等 useLiveQuery 查询 / IndexedDB 写入 / React 提交完成 */
async function flush(): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
  }
}

function saveButton(): HTMLButtonElement {
  const btn = [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes('保存'))
  if (!btn) throw new Error('找不到保存按钮')
  return btn
}

beforeEach(async () => {
  await db.resources.clear()
  await db.progress.clear()
  const doc = { ...blankLevelDoc(), id: DOC_ID, meta: { ...blankLevelDoc().meta, title: '测试关卡' } }
  await db.resources.put({
    id: DOC_ID,
    kind: 'level',
    version: doc.version,
    title: '测试关卡',
    doc,
    importedAt: Date.now(),
    builtIn: 0,
  })
  container = null
  root = null
})

afterEach(async () => {
  vi.restoreAllMocks()
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
})

describe('EditorPage 保存（防重入标记释放）', () => {
  it('同一编辑会话可连续保存多次：保存 → 改名 → 再保存，第二次编辑真正落库', async () => {
    const putSpy = vi.spyOn(db.resources, 'put')
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={DOC_ID} />)
    })
    await flush()
    // 标题在输入框 value 里（textContent 不可见）
    const titleBox = () => container!.querySelector('.editor-title') as HTMLInputElement
    expect(titleBox().value).toBe('测试关卡')

    // 第一次保存
    await act(async () => {
      saveButton().click()
    })
    await flush()
    expect(putSpy).toHaveBeenCalledTimes(1)

    // 改标题（标脏）后第二次保存——修复前：防重入标记未释放，第二次保存被静默吞掉
    const title = titleBox()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(title, '改名关卡')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    await act(async () => {
      saveButton().click()
    })
    await flush()

    expect(putSpy).toHaveBeenCalledTimes(2)
    const saved = putSpy.mock.calls[1][0] as { doc: { meta: { title: string } } }
    expect(saved.doc.meta.title).toBe('改名关卡')
    expect(container!.textContent).toContain('已保存')
  })
})

describe('EditorPage 画布 Delete 快捷删除', () => {
  beforeAll(() => {
    // jsdom 无指针捕获语义：选中组件的 pointerdown 依赖 setPointerCapture
    Element.prototype.setPointerCapture = (): void => {}
    Element.prototype.releasePointerCapture = (): void => {}
  })

  it('选中组件后按 Delete 删除（可 Ctrl+Z 撤销）；输入框聚焦时不拦截', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={DOC_ID} />)
    })
    await flush()

    // 空画布 → 从组件面板添加一个组件
    const addBtn = [...container!.querySelectorAll('.palette button')].find((b) => b.textContent!.startsWith('+ '))
    expect(addBtn).toBeTruthy()
    await act(async () => {
      ;(addBtn as HTMLElement).click()
    })
    await flush()
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(1)

    // pointerdown 选中组件
    await act(async () => {
      container!.querySelector('.editor-box')!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 3 }),
      )
    })
    expect(container!.querySelector('.inspector')).toBeTruthy()

    // 输入框聚焦时按 Delete 不删除（文本编辑优先）
    const title = container!.querySelector('.editor-title') as HTMLInputElement
    await act(async () => {
      title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(1)

    // 画布态按 Delete 删除选中组件（走 update 管线 → 入撤销栈）
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(0)
    expect(container!.querySelector('.inspector')).toBeNull()

    // Ctrl+Z 撤销删除，组件恢复
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(1)
  })
})
