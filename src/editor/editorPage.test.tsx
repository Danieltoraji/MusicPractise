// @vitest-environment jsdom
// EditorPage 保存回归：同一编辑会话可连续保存多次（防重入标记 try/finally 释放——
// 此前 savingRef 置 true 后从未复位，首次保存后「保存/试运行」整会话失效）
// R13（docs/42 §4.5/§4.6/§5.1）：A1 内置分支竞态、C5 状态收口（假横幅/undo 身份/状态迁移）、
// revision 接口、R5 归属、D7 Inspector key、JSON 草稿 stale。
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../library/db'
import type { LibraryRecord } from '../library/db'
import type { LevelDoc } from '../engine/level'
import { blankLevelDoc } from './docState'
import { EditorPage } from './EditorPage'
import { getDebugSnapshot, startDebugRun, stopDebugRun } from './graph/debugRun'
import { getSession, patchSession, appendMessage, clearSession } from '../ai/session'
import { getCheckpoint, saveCheckpoint, clearCheckpoint } from '../ai/checkpoint'
import { appendRunLog, clearRunLog, readRunLog } from '../runtime/runLog'
import { clearDraft, DRAFT_SLOTS, loadDraft, saveDraft } from './draftStore'
import type { JsonDraft } from './draftStore'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** AiPanel 桩捕获的 props（R13 P1 接口：getRevision / onApplyDoc(next, tag) / onClose） */
interface AiPanelMockProps {
  doc: LevelDoc
  getRevision?: () => number
  onApplyDoc: (doc: LevelDoc, tag?: string) => void
  onClose: () => void
}

// R5：stopAgent 用 module mock 断言 EditorPage 的归属（静态导入无法用 spy 替换 ESM 绑定）；
// AiPanel 换桩：编辑器默认开 AI 面板，桩记录 props 供 revision/onApplyDoc 接口测试。
const aiHarness = vi.hoisted(() => ({
  panelProps: { current: null as AiPanelMockProps | null },
  stopAgent: vi.fn(),
}))
vi.mock('../ai/agent', () => ({ stopAgent: aiHarness.stopAgent }))
vi.mock('./ai/AiPanel', () => ({
  AiPanel: (props: AiPanelMockProps) => {
    aiHarness.panelProps.current = props
    return null
  },
}))

const DOC_ID = 'res_01J9E000000000000000000000'
/** 内置示例专用 id（C5/A1 用例独立建档，避免与其它用例的 session/draft 状态串台） */
const BUILTIN_ID = 'res_01J9E0000000000000000000B1'

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
  // G3 渐进口径（docs/44 R15）：关键交互锚点改 data-testid，不再锁按钮文案
  const btn = container!.querySelector('[data-testid="editor-save"]')
  if (!btn) throw new Error('找不到保存按钮')
  return btn as HTMLButtonElement
}

function titleInput(): HTMLInputElement {
  return container!.querySelector('[data-testid="editor-title"]') as HTMLInputElement
}

/** 受控标题输入：native setter + input 事件（React value tracker 放行） */
async function typeTitle(value: string): Promise<void> {
  await act(async () => {
    const input = titleInput()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

const HEAD_BUTTON_TESTID: Record<string, string> = { '↶': 'editor-undo', '↷': 'editor-redo' }
function headButton(text: string): HTMLButtonElement {
  const testid = HEAD_BUTTON_TESTID[text]
  const btn = testid
    ? container!.querySelector(`[data-testid="${testid}"]`)
    : [...container!.querySelectorAll('.editor-head button')].find((b) => b.textContent === text)
  if (!btn) throw new Error(`找不到头部按钮 ${text}`)
  return btn as HTMLButtonElement
}

const TAB_TESTID: Record<string, string> = { 画布: 'canvas', 节点图: 'graph', 脚本: 'script', 数据表: 'table', JSON: 'json' }
function tabButton(label: string): HTMLButtonElement {
  const id = TAB_TESTID[label]
  const btn = id
    ? container!.querySelector(`[data-testid="editor-tab-${id}"]`)
    : [...container!.querySelectorAll('.editor-tabs button')].find((b) => b.textContent === label)
  if (!btn) throw new Error(`找不到 Tab ${label}`)
  return btn as HTMLButtonElement
}

/** 当前 hash 指向的编辑文档 id */
function hashEditId(): string {
  return window.location.hash.replace('#/edit/', '')
}

/** 建一条独立关卡记录（内置/普通由 builtIn 指定），返回其 doc */
async function putLevelDoc(id: string, title: string, builtIn: boolean): Promise<LevelDoc> {
  const base = blankLevelDoc()
  const doc: LevelDoc = { ...base, id, meta: { ...base.meta, title } }
  await db.resources.put({
    id,
    kind: 'level',
    version: doc.version,
    title,
    doc,
    importedAt: Date.now(),
    builtIn: builtIn ? 1 : 0,
  })
  return doc
}

async function mountEditor(id: string): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container!)
    root!.render(<EditorPage id={id} />)
  })
  await flush()
}

function currentPanelProps(): AiPanelMockProps {
  const p = aiHarness.panelProps.current
  if (!p) throw new Error('AiPanel 尚未挂载——检查 aiOpen/tab 条件渲染')
  return p
}

beforeEach(async () => {
  await db.resources.clear()
  await db.progress.clear()
  await db.aiSessions.clear()
  window.location.hash = ''
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
  // 模块级单例跨用例清理（draftStore/session/checkpoint/runLog 按 docId 驻留内存）
  for (const slot of Object.values(DRAFT_SLOTS)) clearDraft(DOC_ID, slot)
  clearSession(DOC_ID)
  clearCheckpoint(DOC_ID)
  clearRunLog(DOC_ID)
  await db.aiSessions.clear()
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

describe('EditorPage 草稿与内置副本（docs/40 R4：C1/C5）', () => {
  beforeAll(() => {
    Element.prototype.setPointerCapture = (): void => {}
    Element.prototype.releasePointerCapture = (): void => {}
  })

  it('C1 回归（§15.2 第 3 条反转）：画布选「视图二」→ 切 JSON → 切回，视图保持不再回落主视图', async () => {
    window.location.hash = '#/edit/new'
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id="new" />)
    })
    await flush()
    // 建第二个视图
    const addViewBtn = [...container!.querySelectorAll('button')].find((b) => b.textContent === '+ 视图') as HTMLButtonElement
    await act(async () => {
      addViewBtn.click()
    })
    await flush()
    // 选中「视图二」
    const view2 = [...container!.querySelectorAll('.views-open')].find((b) => b.textContent?.includes('视图2')) as HTMLButtonElement
    await act(async () => view2.click())
    await flush()
    expect([...container!.querySelectorAll('.views-open')].find((b) => b.textContent?.startsWith('▸'))!.textContent).toContain('视图2')
    // 切 JSON 再切回画布
    const jsonTab = [...container!.querySelectorAll('.editor-tabs button')].find((b) => b.textContent === 'JSON') as HTMLButtonElement
    const canvasTab = [...container!.querySelectorAll('.editor-tabs button')].find((b) => b.textContent === '画布') as HTMLButtonElement
    await act(async () => jsonTab.click())
    await flush()
    await act(async () => canvasTab.click())
    await flush()
    // 修复前：切走卸载 → 视图退回主视图
    const current = [...container!.querySelectorAll('.views-open')].find((b) => b.textContent?.startsWith('▸'))!
    expect(current.textContent).toContain('视图2')
    window.location.hash = '#/library'
  })

  it('C5 回归：内置示例保存后原地另存副本（hash 换 id、不重挂——撤销栈保留、提示直接展示）', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={DOC_ID} />)
    })
    await flush()
    // 把该记录标成内置（模拟内置示例编辑场景）
    const rec = await db.resources.get(DOC_ID)
    await db.resources.put({ ...(rec as object), builtIn: 1 } as never)
    // 加组件产生历史
    const addBtn = [...container!.querySelectorAll('.palette button')].find((b) => b.textContent!.startsWith('+ ')) as HTMLButtonElement
    await act(async () => addBtn.click())
    await flush()
    const undoBefore = [...container!.querySelectorAll('.editor-head button')].find((b) => b.textContent === '↶') as HTMLButtonElement
    expect(undoBefore.disabled).toBe(false)
    // 保存 → 另存副本
    await act(async () => {
      saveButton().click()
    })
    await flush()
    expect(window.location.hash).toMatch(/^#\/edit\/res_/) // 换到副本 id
    expect(window.location.hash).not.toContain(DOC_ID)
    // 未重挂：撤销栈保留（一次 undo 可回退加组件）
    const undoAfter = [...container!.querySelectorAll('.editor-head button')].find((b) => b.textContent === '↶') as HTMLButtonElement
    expect(undoAfter.disabled).toBe(false)
    expect(container!.textContent).toContain('已另存为你的副本')
    // 脏标已清
    expect(saveButton().textContent).not.toContain(' *')
  })
})

describe('EditorPage Inspector props（docs/40 R4 D7）', () => {
  beforeAll(() => {
    Element.prototype.setPointerCapture = (): void => {}
    Element.prototype.releasePointerCapture = (): void => {}
  })

  it('props JSON 输入 null：明确报错「必须是 JSON 对象」（null 裁决）', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id={DOC_ID} />)
    })
    await flush()
    const addBtn = [...container!.querySelectorAll('.palette button')].find((b) => b.textContent!.startsWith('+ ')) as HTMLButtonElement
    await act(async () => addBtn.click())
    await flush()
    await act(async () => {
      container!.querySelector('.editor-box')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3 }))
    })
    // 展开 props JSON details 并输入 null
    const summary = [...container!.querySelectorAll('.inspector details summary')].find((el) => el.textContent?.includes('props JSON')) as HTMLElement
    await act(async () => summary.click())
    await flush()
    const ta = container!.querySelector('.inspector details textarea') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(ta, 'null')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container!.querySelector('.inspector')!.textContent).toContain('必须是 JSON 对象')
  })
})

describe('EditorPage 调试会话宿主生命周期（docs/40 R5：C3）', () => {
  it('切离节点图 Tab / 卸载编辑器 → 调试会话停止（不再跨 Tab 播音频跑计时器）', async () => {
    window.location.hash = '#/edit/new'
    container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      root = createRoot(container!)
      root!.render(<EditorPage id="new" />)
    })
    await flush()
    // 切到节点图 Tab 并启动调试（GraphEditor 懒加载不需要真正渲染——startDebugRun 是模块单例）
    const graphTab = [...container!.querySelectorAll('.editor-tabs button')].find((b) => b.textContent === '节点图') as HTMLButtonElement
    await act(async () => graphTab.click())
    await flush()
    const doc = blankLevelDoc()
    await act(async () => {
      await startDebugRun(doc)
    })
    expect(getDebugSnapshot().mode).toBe('running')
    // 切画布 Tab → 会话停止（修复前：隐藏会话继续跑）
    const canvasTab = [...container!.querySelectorAll('.editor-tabs button')].find((b) => b.textContent === '画布') as HTMLButtonElement
    await act(async () => canvasTab.click())
    await flush()
    expect(getDebugSnapshot().mode).toBe('idle')
    // 重启后再卸载编辑器 → 停止
    await act(async () => {
      await startDebugRun(doc)
    })
    expect(getDebugSnapshot().mode).toBe('running')
    await act(async () => {
      root?.unmount()
    })
    root = null
    expect(getDebugSnapshot().mode).toBe('idle')
    stopDebugRun()
    window.location.hash = '#/library'
  })
})

// ---------------------------------------------------------------------------
// R13 返工（docs/42 §4.5/§4.6/§5.1）：W1 编辑器核心
// ---------------------------------------------------------------------------

describe('EditorPage revision 接口（R13 P1：W2 F1 冲突检测契约）', () => {
  it('getRevision 随编辑/撤销/AI 应用/保存递增；onApplyDoc(next, tag) 走 update', async () => {
    await mountEditor(DOC_ID)
    const first = currentPanelProps()
    expect(typeof first.getRevision).toBe('function')
    const r0 = first.getRevision!()

    await typeTitle('手动改名')
    const r1 = currentPanelProps().getRevision!()
    expect(r1).toBeGreaterThan(r0)

    // AI 写入通道：双参 onApplyDoc(next, tag)——W2 每次 run 传独立撤销 tag
    const props = currentPanelProps()
    const next = { ...props.doc, meta: { ...props.doc.meta, title: 'AI 写入' } }
    const beforeApply = props.getRevision!()
    await act(async () => {
      props.onApplyDoc(next, 'ai:1')
    })
    await flush()
    expect(titleInput().value).toBe('AI 写入')
    const r2 = currentPanelProps().getRevision!()
    expect(r2).toBeGreaterThan(beforeApply)

    // undo 也是手动修改：修订号递增（AI 运行期创作者撤销 → agent 写入前检测到冲突）
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    await flush()
    expect(titleInput().value).toBe('手动改名')
    const r3 = currentPanelProps().getRevision!()
    expect(r3).toBeGreaterThan(r2)

    // 保存成功回写规范化 doc（新版本）→ 修订号递增
    await act(async () => {
      saveButton().click()
    })
    await flush()
    const r4 = currentPanelProps().getRevision!()
    expect(r4).toBeGreaterThan(r3)
    expect(container!.textContent).toContain('已保存')
  })
})

describe('EditorPage R5 AI run 归属（EditorPage 侧兜底）', () => {
  it('关闭 AI 面板 / 面板 onClose / 卸载编辑器 → stopAgent(当前 doc id)', async () => {
    await mountEditor(DOC_ID)
    expect(aiHarness.panelProps.current).not.toBeNull()
    aiHarness.stopAgent.mockClear()

    // 🤖 总开关关闭（外置面板与节点图 Dock 共用 aiOpen 单一真源）
    await act(async () => {
      ;(container!.querySelector('.editor-ai-toggle') as HTMLButtonElement).click()
    })
    await flush()
    expect(aiHarness.stopAgent).toHaveBeenCalledWith(DOC_ID)

    // 重新打开 → 面板 onClose 显式停止（AiPanel 卸载本身不再 abort，由 EditorPage 兜）
    await act(async () => {
      ;(container!.querySelector('.editor-ai-toggle') as HTMLButtonElement).click()
    })
    await flush()
    aiHarness.stopAgent.mockClear()
    await act(async () => {
      currentPanelProps().onClose()
    })
    await flush()
    expect(aiHarness.stopAgent).toHaveBeenCalledWith(DOC_ID)

    // 离开编辑器（卸载）→ 停止当前文档的 run（docRef 为真源）
    aiHarness.stopAgent.mockClear()
    await act(async () => {
      root?.unmount()
    })
    root = null
    expect(aiHarness.stopAgent).toHaveBeenCalledWith(DOC_ID)
  })
})

describe('EditorPage A1 内置示例保存竞态（docs/42 §4.5）', () => {
  it('慢速 put 期间的编辑按副本身份保留：不回滚标题、脏标保留、提示再次保存；随后保存不新建副本', async () => {
    await putLevelDoc(BUILTIN_ID, '内置示例', true)
    const realPut = db.resources.put.bind(db.resources)
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const putSpy = vi
      .spyOn(db.resources, 'put')
      .mockImplementation(((rec: LibraryRecord) => gate.then(() => realPut(rec))) as never)
    await mountEditor(BUILTIN_ID)

    await typeTitle('保存前标题')
    await act(async () => {
      saveButton().click()
    })
    // put 挂起：save 已走到 await putResource（saving 态已提交）
    expect(saveButton().textContent).toContain('保存中')

    // 保存 await 窗口里的编辑
    await typeTitle('窗口期编辑')

    await act(async () => {
      release()
    })
    await flush()

    const copyId = hashEditId()
    expect(copyId).toMatch(/^res_/)
    expect(copyId).not.toBe(BUILTIN_ID)
    // 窗口期编辑未被无条件 setDoc(saved) 回滚；脏标保留并提示再次保存
    expect(titleInput().value).toBe('窗口期编辑')
    expect(saveButton().textContent).toContain(' *')
    expect(container!.textContent).toContain('保存期间又有新的修改')
    // 写库对象 = 点击时刻内容（标题带副本后缀），且无假外部修改横幅
    const firstPut = putSpy.mock.calls[0][0] as { doc: LevelDoc }
    expect(firstPut.doc.meta.title).toBe('保存前标题（副本）')
    expect(container!.textContent).not.toContain('文档已在其他窗口被修改')

    // 立即再保存：已是副本记录（builtIn=0）→ 同 id 更新，不再另建第二份副本
    await act(async () => {
      saveButton().click()
    })
    await flush()
    const secondPut = putSpy.mock.calls[1][0] as { id: string; doc: LevelDoc }
    expect(secondPut.id).toBe(copyId)
    expect(secondPut.doc.meta.title).toBe('窗口期编辑')
    const all = await db.resources.toArray()
    // beforeEach 的 DOC_ID 普通档 + 内置原档 + 一份副本 = 3（第二份副本会再多一条）
    expect(all.filter((r) => r.id !== BUILTIN_ID && r.id !== DOC_ID)).toHaveLength(1)
    expect((await db.resources.get(copyId))?.title).toBe('窗口期编辑')
    expect(saveButton().textContent).not.toContain(' *') // 第二次无竞态 → 正常清脏
  })
})

describe('EditorPage C5 内置副本状态收口（docs/42 §4.6）', () => {
  it('假横幅不出现；Ctrl+Z 身份不回退（标题仍含（副本）、doc.id 与 hash 一致）；再保存不新建副本', async () => {
    await putLevelDoc(BUILTIN_ID, '内置示例', true)
    const putSpy = vi.spyOn(db.resources, 'put')
    await mountEditor(BUILTIN_ID)
    await typeTitle('改过标题') // 制造历史（撤销栈非空）
    expect(headButton('↶').disabled).toBe(false)

    await act(async () => {
      saveButton().click()
    })
    await flush()
    const copyId = hashEditId()
    expect(copyId).not.toBe(BUILTIN_ID)
    expect(titleInput().value).toBe('改过标题（副本）')
    // C5 假横幅：record/版本基线已前移到副本，不再误报「文档已在其他窗口被修改」
    expect(container!.textContent).not.toContain('文档已在其他窗口被修改')

    // 保存后 Ctrl+Z：历史栈身份已重映射——doc.id 不回退到内置 id，标题仍带副本后缀
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    await flush()
    expect(hashEditId()).toBe(copyId)
    expect(currentPanelProps().doc.id).toBe(copyId) // doc.id 与 hash 一致
    expect(titleInput().value).toContain('（副本）')
    expect(titleInput().value).not.toBe('内置示例') // 不是内置原档标题

    // 再保存：同 id 更新，不因 existing.builtIn=1 另建副本
    await act(async () => {
      saveButton().click()
    })
    await flush()
    expect(hashEditId()).toBe(copyId)
    const savedIds = putSpy.mock.calls.map((c) => (c[0] as { id: string }).id)
    expect(savedIds).toEqual([copyId, copyId])
    // beforeEach 的 DOC_ID + 内置原档 + 一份副本 = 3（若另建第二份副本会变成 4）
    expect(await db.resources.toArray()).toHaveLength(3)
  })

  it('保存内置副本时迁移 session/checkpoint/draft/runLog/aiSessions 到副本 id（同挂载内状态保持）', async () => {
    const builtin = await putLevelDoc(BUILTIN_ID, '内置示例', true)
    await mountEditor(BUILTIN_ID)
    // 旧 id 上的运行时状态
    appendMessage(BUILTIN_ID, { role: 'user', content: '旧对话' })
    patchSession(BUILTIN_ID, { mode: 'agent', busy: true, checkpointAt: 123 })
    saveCheckpoint(BUILTIN_ID, builtin)
    const drafted: JsonDraft = { text: '{"kind":"level"}', baselineSig: 'sig-old' }
    saveDraft(BUILTIN_ID, DRAFT_SLOTS.jsonText, drafted)
    saveDraft(BUILTIN_ID, DRAFT_SLOTS.aiInput, '待发提问')
    // canvasView 槽由挂载中的画布组件在换 id 后以实时视图状态重写（活状态优先），
    // 迁移正确性以未挂载消费方的三槽 + draftStore 单测（四槽）为准
    saveDraft(BUILTIN_ID, DRAFT_SLOTS.tableLayout, { colW: { data: 120 } })
    appendRunLog(BUILTIN_ID, { kind: 'command', path: 'x.play', t: 1 })
    await db.aiSessions.put({
      docId: BUILTIN_ID,
      messages: [{ role: 'user', content: '持久化对话' }],
      plan: null,
      mode: 'agent',
      updatedAt: 1,
    })

    await act(async () => {
      saveButton().click()
    })
    await flush()
    const copyId = hashEditId()
    expect(copyId).not.toBe(BUILTIN_ID)

    // AI 会话（消息/plan/mode/checkpointAt）跟到副本 id；显式停止旧 run 后不残留 busy
    const moved = getSession(copyId)
    expect(moved.messages.map((m) => m.content)).toContain('旧对话')
    expect(moved.mode).toBe('agent')
    expect(moved.checkpointAt).toBe(123)
    expect(moved.busy).toBe(false)
    expect(getSession(BUILTIN_ID).messages).toHaveLength(0)
    // checkpoint Map
    expect(getCheckpoint(copyId)).toBeTruthy()
    expect(getCheckpoint(BUILTIN_ID)).toBeNull()
    // draftStore 三槽（canvasView 由挂载中的画布以实时状态重写，见上）
    expect(loadDraft<JsonDraft>(copyId, DRAFT_SLOTS.jsonText)).toEqual(drafted)
    expect(loadDraft(copyId, DRAFT_SLOTS.aiInput)).toBe('待发提问')
    expect(loadDraft(copyId, DRAFT_SLOTS.tableLayout)).toEqual({ colW: { data: 120 } })
    expect(loadDraft(BUILTIN_ID, DRAFT_SLOTS.jsonText)).toBeUndefined()
    // runLog
    expect(readRunLog(copyId)).toHaveLength(1)
    expect(readRunLog(BUILTIN_ID)).toHaveLength(0)
    // IndexedDB aiSessions 记录也换 id
    const rec = await db.aiSessions.get(copyId)
    expect(rec?.docId).toBe(copyId)
    expect(await db.aiSessions.get(BUILTIN_ID)).toBeUndefined()
    // 面板 doc 身份已是副本
    expect(currentPanelProps().doc.id).toBe(copyId)
  })

  it('A8 外部修改横幅仍生效（record 与 activeId 一致才显示）；加载走 confirm + update（可 Ctrl+Z）', async () => {
    await mountEditor(DOC_ID)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    const rec = (await db.resources.get(DOC_ID)) as LibraryRecord
    const recDoc = rec.doc as LevelDoc
    await db.resources.put({
      ...rec,
      version: '0.9.9',
      title: '外部版本',
      doc: { ...recDoc, meta: { ...recDoc.meta, title: '外部版本' } },
    })
    await flush()
    expect(container!.textContent).toContain('文档已在其他窗口被修改')

    const loadBtn = () =>
      [...container!.querySelectorAll('.editor-lint button')].find((b) =>
        b.textContent?.includes('加载外部版本'),
      ) as HTMLButtonElement
    // 取消 confirm → 不加载、仍保留横幅（旧实现一次点击即覆盖，无确认）
    await act(async () => {
      loadBtn().click()
    })
    await flush()
    expect(confirmSpy).toHaveBeenCalled()
    expect(titleInput().value).toBe('测试关卡')
    expect(container!.textContent).toContain('文档已在其他窗口被修改')

    // 确认 → 加载外部版本（走 update 入撤销栈）；与库内版本对齐后不算未保存修改
    confirmSpy.mockReturnValueOnce(true)
    await act(async () => {
      loadBtn().click()
    })
    await flush()
    expect(titleInput().value).toBe('外部版本')
    expect(container!.textContent).not.toContain('文档已在其他窗口被修改')
    expect(saveButton().textContent).not.toContain(' *')
    // Ctrl+Z 撤回加载（旧实现直接 setDoc 不可撤销）
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    await flush()
    expect(titleInput().value).toBe('测试关卡')
    expect(saveButton().textContent).toContain(' *')
  })
})

describe('EditorPage D7 切换组件重置 props 草稿（docs/42 §5.1-14）', () => {
  beforeAll(() => {
    Element.prototype.setPointerCapture = (): void => {}
    Element.prototype.releasePointerCapture = (): void => {}
  })

  it('组件 A 的非法 props 报错不残留到组件 B；B 的 props 文本正确', async () => {
    await mountEditor(DOC_ID)
    const paletteBtn = (i: number): HTMLButtonElement =>
      [...container!.querySelectorAll('.palette button')].filter((b) =>
        b.textContent!.startsWith('+ '),
      )[i] as HTMLButtonElement
    await act(async () => paletteBtn(0).click())
    await flush()
    await act(async () => paletteBtn(1).click())
    await flush()
    const boxes = () => [...container!.querySelectorAll('.editor-box')]
    expect(boxes()).toHaveLength(2)
    const selectBox = async (i: number): Promise<void> => {
      await act(async () => {
        boxes()[i].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 3 }))
      })
      await flush()
    }
    const summary = (): HTMLElement =>
      [...container!.querySelectorAll('.inspector details summary')].find((el) =>
        el.textContent?.includes('props JSON'),
      ) as HTMLElement
    const textarea = (): HTMLTextAreaElement => container!.querySelector('.inspector details textarea') as HTMLTextAreaElement

    await selectBox(0)
    await act(async () => summary().click())
    await flush()
    await act(async () => {
      const ta = textarea()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, 'null')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container!.querySelector('.inspector')!.textContent).toContain('必须是 JSON 对象')

    // 切换组件 B：Inspector 按组件 id 重挂——A 的报错草稿不残留
    await selectBox(1)
    expect(container!.querySelector('.inspector')!.textContent).not.toContain('必须是 JSON 对象')
    await act(async () => summary().click())
    await flush()
    expect(textarea().value).toBe('{}') // B 自己的 props，而不是 A 的报错草稿文本
  })
})

describe('EditorPage JSON 草稿 stale（docs/42 §5.1-13）', () => {
  it('文档被其它操作修改后：黄条提示 + 禁用应用；从当前文档重新生成后恢复', async () => {
    await mountEditor(DOC_ID)
    await act(async () => tabButton('JSON').click())
    await flush()
    const textarea = (): HTMLTextAreaElement => container!.querySelector('.json-tab textarea') as HTMLTextAreaElement
    // 编辑 JSON 草稿（不应用）：改标题
    const draftDoc = JSON.parse(textarea().value) as { meta: { title: string } }
    draftDoc.meta.title = '草稿标题'
    await act(async () => {
      const ta = textarea()
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, JSON.stringify(draftDoc, null, 2))
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await flush()
    // 切回画布，从标题输入框修改同一文档（模拟 AI/undo/其它 Tab 修改）
    await act(async () => tabButton('画布').click())
    await flush()
    await typeTitle('外部操作修改')
    // 回 JSON Tab：草稿仍在（C1）但基线签名失配 → 黄条 + 禁用应用
    await act(async () => tabButton('JSON').click())
    await flush()
    expect(textarea().value).toContain('草稿标题')
    expect(container!.textContent).toContain('文档已被其它操作修改')
    const applyBtn = () =>
      [...container!.querySelectorAll('.json-tab button')].find((b) =>
        b.textContent?.includes('应用 JSON'),
      ) as HTMLButtonElement
    expect(applyBtn().disabled).toBe(true)

    // 从当前文档重新生成 → 对齐当前文档、黄条消失、应用恢复可用
    const regenBtn = [...container!.querySelectorAll('.json-tab button')].find(
      (b) => b.textContent === '从当前文档重新生成',
    ) as HTMLButtonElement
    expect(regenBtn).toBeTruthy()
    await act(async () => regenBtn.click())
    await flush()
    expect(container!.textContent).not.toContain('文档已被其它操作修改')
    expect(textarea().value).toContain('外部操作修改')
    expect(applyBtn().disabled).toBe(false)
  })

  it('保存 bump version 不应触发 JSON 草稿陈旧误报（基线签名只取内容，排除 id/version）', async () => {
    await mountEditor(DOC_ID)
    await act(async () => tabButton('JSON').click())
    await flush()
    const applyBtn = () =>
      [...container!.querySelectorAll('.json-tab button')].find((b) =>
        b.textContent?.includes('应用 JSON'),
      ) as HTMLButtonElement
    expect(applyBtn().disabled).toBe(false)
    // 保存只改 version（A3 bump），内容未变——草稿基线不得被判陈旧
    await act(async () => saveButton().click())
    await flush()
    expect(container!.textContent).not.toContain('文档已被其它操作修改')
    expect(applyBtn().disabled).toBe(false)
  })
})

describe('EditorPage 装载 lint（F6 / docs/44 R16）', () => {
  it('打开关卡即展示 flow.pass 语法错误与悬空视图告警（与保存路径同口径）', async () => {
    const base = blankLevelDoc()
    const seeded = {
      ...base,
      id: DOC_ID,
      meta: { ...base.meta, title: '测试关卡' },
      content: {
        ...base.content,
        flow: { pass: { expr: 'v.score >=' } },
        components: [{ id: 'dangling', type: 'label', view: 'ghost' }],
      },
    } as LevelDoc
    await db.resources.put({
      id: DOC_ID,
      kind: 'level',
      version: seeded.version,
      title: '测试关卡',
      doc: seeded,
      importedAt: Date.now(),
      builtIn: 0,
    })
    await mountEditor(DOC_ID)
    const lint = container!.querySelector('.editor-lint')?.textContent ?? ''
    expect(lint).toContain('flow.pass')
    expect(lint).toContain('不存在的视图')
    expect(lint).toContain('ghost')
  })
})
