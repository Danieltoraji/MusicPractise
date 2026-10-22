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

describe('EditorPage 快捷键守卫与删除单次入栈（docs/40 B3/B5）', () => {
  beforeAll(() => {
    Element.prototype.setPointerCapture = (): void => {}
    Element.prototype.releasePointerCapture = (): void => {}
  })

  /** 挂载 + 添加并选中一个组件，返回 Inspector 根元素 */
  async function mountWithSelectedComponent(): Promise<void> {
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={DOC_ID} />)
    })
    await flush()
    const addBtn = [...container!.querySelectorAll('.palette button')].find((b) => b.textContent!.startsWith('+ '))
    await act(async () => {
      ;(addBtn as HTMLElement).click()
    })
    await flush()
    await act(async () => {
      container!.querySelector('.editor-box')!.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, pointerId: 3 }),
      )
    })
    expect(container!.querySelector('.inspector')).toBeTruthy()
  }

  it('B5 回归：焦点在 Inspector 的 SELECT 上按 Delete 不删除组件', async () => {
    await mountWithSelectedComponent()
    // 聚焦「所属视图」下拉——修复前：SELECT 不在守卫清单里，按 Delete 组件被误删
    const select = container!.querySelector('.inspector select') as HTMLSelectElement
    await act(async () => {
      select.focus()
      select.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(1)

    // 焦点回到画布态（body）按 Delete 仍可正常删除——守卫没有把功能一并关掉
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    })
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(0)
  })

  it('B3 回归：Inspector「删除组件」只入一次撤销栈——连按两次 Ctrl+Z 依次回退删除与添加', async () => {
    await mountWithSelectedComponent()
    const delBtn = [...container!.querySelectorAll('.inspector button')].find((b) => b.textContent === '删除组件')!
    await act(async () => {
      ;(delBtn as HTMLElement).click()
    })
    await flush()
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(0)
    // 撤销 #1：回退删除，组件恢复
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(1)
    // 撤销 #2：回退添加（修复前这里是空撤销步，界面不变）
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    expect(container!.querySelectorAll('.editor-box')).toHaveLength(0)
  })
})

describe('EditorPage 装载失败分支（docs/40 A4）', () => {
  it('毒数据（不受支持的 schemaVersion）→ 可读错误页 + 返回资源库/重试，不再无限「加载中」', async () => {
    const POISON_ID = 'res_01J9E000000000000000000001'
    await db.resources.put({
      id: POISON_ID,
      kind: 'level',
      version: '0.1.0',
      title: '毒文档',
      doc: { kind: 'level', schemaVersion: 99, id: POISON_ID, content: null },
      importedAt: Date.now(),
      builtIn: 0,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={POISON_ID} />)
    })
    await flush()
    expect(container!.textContent).toContain('无法打开这个关卡')
    expect(container!.textContent).toContain('schemaVersion 99 不受支持')
    expect(container!.querySelector('a[href="#/library"]')).toBeTruthy()
    const retry = [...container!.querySelectorAll('button')].find((b) => b.textContent === '重试')
    expect(retry).toBeTruthy()
  })
})

describe('EditorPage 保存链路收口（docs/40 A1/A2/A3/A7）', () => {
  it('A3 回归：连续保存 version 递增（0.1.0 → 0.1.1）', async () => {
    const putSpy = vi.spyOn(db.resources, 'put')
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={DOC_ID} />)
    })
    await flush()
    await act(async () => {
      saveButton().click()
    })
    await flush()
    const title = container!.querySelector('.editor-title') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(title, '再改一次')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    await act(async () => {
      saveButton().click()
    })
    await flush()
    expect(putSpy).toHaveBeenCalledTimes(2)
    const v1 = (putSpy.mock.calls[0][0] as { doc: { version: string } }).doc.version
    const v2 = (putSpy.mock.calls[1][0] as { doc: { version: string } }).doc.version
    // 库内基线 0.1.0 → 首存 bump 落库 0.1.1 → 再存 0.1.2（修复前两次都是 0.1.0，导入「同版本跳过」会静默丢更新）
    expect(v1).toBe('0.1.1')
    expect(v2).toBe('0.1.2')
    expect(container!.textContent).toContain('v0.1.2')
  })

  it('A1 回归：保存 await 期间的新编辑不被当作已保存——脏标保留并提示再次保存', async () => {
    let resolvePut: (() => void) | null = null
    vi.spyOn(db.resources, 'put').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePut = () => resolve(undefined as never)
          // 挂起 put：模拟 IndexedDB 排队/大文档写入窗口
        }) as never,
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={DOC_ID} />)
    })
    await flush()
    await act(async () => {
      saveButton().click()
    })
    // put 挂起期间改标题（保存竞态窗口）
    const title = container!.querySelector('.editor-title') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(title, '竞态窗口里的编辑')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      resolvePut?.()
    })
    await flush()
    // 修复前：无条件 setDirty(false) → 脏标消失，跳转/关页不再确认 → 静默丢这条编辑
    expect(saveButton().textContent).toContain(' *')
    expect(container!.textContent).toContain('保存期间又有新的修改')
  })

  it('A2 回归：put 抛错 → 可读错误条 + 脏标保留（不再静默无反应）', async () => {
    vi.spyOn(db.resources, 'put').mockRejectedValue(new Error('QuotaExceededError'))
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={DOC_ID} />)
    })
    await flush()
    // 先制造一条编辑（置脏）
    const title = container!.querySelector('.editor-title') as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(title, '失败前的编辑')
      title.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    await act(async () => {
      saveButton().click()
    })
    await flush()
    expect(container!.textContent).toContain('保存失败')
    expect(container!.textContent).toContain('QuotaExceededError')
    expect(saveButton().textContent).toContain(' *') // 脏标保留：失败 ≠ 已保存
    // 恢复 mock 后可直接重试成功（saving 已复位）
    vi.restoreAllMocks()
    await act(async () => {
      saveButton().click()
    })
    await flush()
    expect(container!.textContent).toContain('已保存')
  })

  it('A7 回归：#/edit/new 首次保存成功后原地切真实 id（replaceState 不重挂）', async () => {
    window.location.hash = '#/edit/new'
    vi.spyOn(db.resources, 'put')
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id="new" />)
    })
    await flush()
    expect(container!.querySelector('.editor-title')).toBeTruthy() // 空白模板已装载
    await act(async () => {
      saveButton().click()
    })
    await flush()
    expect(window.location.hash).toMatch(/^#\/edit\/res_/) // 修复前停在 #/edit/new，刷新回空白模板可再造第二条
    expect(container!.querySelector('.editor-title')).toBeTruthy() // 未发生整页重挂（编辑器仍在）
    window.location.hash = '#/library'
  })
})
