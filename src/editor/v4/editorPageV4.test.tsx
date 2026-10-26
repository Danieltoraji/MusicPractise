// @vitest-environment jsdom
/**
 * EditorPageV4 容器测试（docs/53 §13.1；W5.1 DoD）：
 * - 加载：db.resources.get → loadLevelDocV4；
 * - 保存：loadLevelDocV4 预检 → bumpVersion → putResource，重开后内容一致；
 * - 撤销/重做 / 快捷键 / revision / 脏标（clean 基线）；
 * - 内置示例另存副本（新 id +「（副本）」+ 草稿迁移 + 撤销栈身份重映射）；
 * - 身份不合法的文档（如 v3）走加载失败分支，不白屏。
 */
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type { LevelDocV4 } from '../../engine/v4/model'
import { db } from '../../library/db'
import { loadLevelDocV4 } from '../../library/validate'
import { DRAFT_SLOTS, loadDraft } from '../draftStore'
import { EditorPageV4 } from './EditorPageV4'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Mounted {
  container: HTMLElement
  unmount: () => void
}

const mountedList: Mounted[] = []

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  const mounted: Mounted = {
    container,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
  mountedList.push(mounted)
  return mounted
}

/** 等 useLiveQuery 查询 / IndexedDB 写入 / React 提交完成 */
async function flush(): Promise<void> {
  for (let i = 0; i < 15; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
}

async function flushUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('flushUntil 超时')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }
}

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`找不到锚点 ${testId}`)
  return el as HTMLElement
}

function click(el: Element): void {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

/**
 * 保存按钮点击：save 是 async（await db.resources.get/put + 状态回写），
 * 必须在同一个 act 内推进若干 macrotask，否则 React 会告警「update not wrapped in act」。
 */
async function clickSave(container: HTMLElement): Promise<void> {
  const button = byTestId(container, 'editor-save')
  await act(async () => {
    ;(button as HTMLElement).click()
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 10))
  })
  await flush()
}

const nativeInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!

async function typeTitle(container: HTMLElement, value: string): Promise<void> {
  await act(async () => {
    const input = byTestId(container, 'editor-title') as HTMLInputElement
    nativeInputValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

function titleValue(container: HTMLElement): string {
  return (byTestId(container, 'editor-title') as HTMLInputElement).value
}

/** 建一条 v4 关卡记录 */
async function putLevelRecord(id: string, builtIn: boolean, mutate?: (doc: LevelDocV4) => void): Promise<LevelDocV4> {
  const doc = minimalLevelDoc()
  doc.id = id
  doc.meta = { ...doc.meta, title: builtIn ? '内置示例关卡' : '普通关卡' }
  mutate?.(doc)
  await db.resources.put({
    id,
    kind: 'level',
    version: doc.version,
    title: String(doc.meta.title ?? ''),
    doc,
    importedAt: Date.now(),
    builtIn: builtIn ? 1 : 0,
  })
  return doc
}

beforeEach(async () => {
  window.location.hash = ''
  await db.resources.clear()
  await db.progress.clear()
})

afterEach(async () => {
  mountedList.splice(0).forEach((mounted) => mounted.unmount())
  await db.resources.clear()
  window.location.hash = ''
})

describe('EditorPageV4 加载 / 保存', () => {
  it('装载库内 v4 文档并显示标题与 lint 警告', async () => {
    const doc = await putLevelRecord('res_01J9V400000000000000000001', false)
    const mounted = mount(<EditorPageV4 id={doc.id} />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-editor"]') !== null)
    expect(titleValue(mounted.container)).toBe('普通关卡')
    expect(byTestId(mounted.container, 'v4-editor-revision').textContent).toContain('rev')
    expect(byTestId(mounted.container, 'editor-save')).toBeTruthy()
  })

  it('编辑标题 → 保存：版本升修订号、脏标清除、重开后内容一致', async () => {
    const doc = await putLevelRecord('res_01J9V400000000000000000002', false)
    const mounted = mount(<EditorPageV4 id={doc.id} />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-editor"]') !== null)
    expect(byTestId(mounted.container, 'editor-save').textContent).not.toContain('*')

    await typeTitle(mounted.container, '改过的标题')
    expect(byTestId(mounted.container, 'editor-save').textContent).toContain('*')
    await clickSave(mounted.container)
    await flushUntil(() => mounted.container.querySelector('[data-testid="editor-saved-tip"]') !== null)

    const saved = await db.resources.get(doc.id)
    expect(String(saved?.title)).toBe('改过的标题')
    expect(saved?.version).toBe('1.0.1')
    expect(byTestId(mounted.container, 'editor-save').textContent).not.toContain('*')
    expect(byTestId(mounted.container, 'editor-saved-tip').textContent).toContain('已保存')

    // 重开一致：卸载后重新装载，标题/版本来自库内
    mounted.unmount()
    mountedList.splice(0)
    const reopened = mount(<EditorPageV4 id={doc.id} />)
    await flushUntil(() => reopened.container.querySelector('[data-testid="v4-editor"]') !== null)
    expect(titleValue(reopened.container)).toBe('改过的标题')
    const loaded = loadLevelDocV4((await db.resources.get(doc.id))?.doc)
    expect(loaded.ok).toBe(true)
    expect(loaded.ok && String(loaded.doc.meta.title)).toBe('改过的标题')
  })

  it('数据表编辑不修改 flow：保存的文档 flow 与装载时引用一致（结构共享）', async () => {
    const doc = await putLevelRecord('res_01J9V400000000000000000003', false)
    const mounted = mount(<EditorPageV4 id={doc.id} />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-editor"]') !== null)
    // 加一行（走内容 Tab）
    click(byTestId(mounted.container, 'v4-tgrid-add-row'))
    await flush()
    await clickSave(mounted.container)
    await flushUntil(() => mounted.container.querySelector('[data-testid="editor-saved-tip"]') !== null)
    const saved = await db.resources.get(doc.id)
    const savedDoc = saved?.doc as LevelDocV4
    expect(savedDoc.content.tables.choice.rows).toHaveLength(4)
    expect(savedDoc.content.flow).toEqual(doc.content.flow)
  })

  it('从零建关（#/edit/new）：空白 v4 文档 → 编辑数据 → 首存落库并切换路由到真实 id', async () => {
    const mounted = mount(<EditorPageV4 id="new" />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-editor"]') !== null)
    expect(titleValue(mounted.container)).toBe('未命名关卡')
    // 从零建：加题型 → 加行 → 录题（全部走内容 Tab）
    click(byTestId(mounted.container, 'v4-content-add-type'))
    await flush()
    click(byTestId(mounted.container, 'v4-tgrid-add-row'))
    await flush()
    const typePrefix = 'type' // addType 生成的 id 带随机后缀，从库内回读断言更稳
    await typeTitle(mounted.container, '从零建的关卡')
    await clickSave(mounted.container)
    await flushUntil(() => mounted.container.querySelector('[data-testid="editor-saved-tip"]') !== null)

    const all = await db.resources.toArray()
    expect(all).toHaveLength(1)
    const record = all[0]
    expect(record.builtIn).toBe(0)
    expect(String(record.title)).toBe('从零建的关卡')
    expect(record.id).not.toBe('new')
    expect(window.location.hash).toBe(`#/edit/${record.id}`)
    const savedDoc = record.doc as LevelDocV4
    expect(savedDoc.content.types).toHaveLength(1)
    expect(savedDoc.content.types[0].id.startsWith(typePrefix)).toBe(true)
    expect(savedDoc.content.tables[savedDoc.content.types[0].id].rows).toHaveLength(1)
    // 首存后仍可继续编辑并再保存（activeId 已切到真实 id）
    await typeTitle(mounted.container, '从零建的关卡·改')
    await clickSave(mounted.container)
    const again = await db.resources.get(record.id)
    expect(String(again?.title)).toBe('从零建的关卡·改')
    expect(again?.version).toBe('0.1.2')
  })
})

describe('EditorPageV4 撤销 / 重做 / revision', () => {
  it('标题连续输入合并为一条撤销步；undo 回保存基线清脏', async () => {
    const doc = await putLevelRecord('res_01J9V400000000000000000004', false)
    const mounted = mount(<EditorPageV4 id={doc.id} />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-editor"]') !== null)
    // 先保存一次 → clean 基线前移（脏标判定的参照）
    await clickSave(mounted.container)
    await flush()
    await flushUntil(() => mounted.container.querySelector('[data-testid="editor-saved-tip"]') !== null)
    const initial = titleValue(mounted.container)
    const revisionStart = Number(byTestId(mounted.container, 'v4-editor-revision').textContent!.replace(/\D/g, ''))

    await typeTitle(mounted.container, '第一')
    await typeTitle(mounted.container, '第一版')
    expect(titleValue(mounted.container)).toBe('第一版')
    const revisionAfterEdit = Number(byTestId(mounted.container, 'v4-editor-revision').textContent!.replace(/\D/g, ''))
    expect(revisionAfterEdit).toBeGreaterThan(revisionStart)
    expect(byTestId(mounted.container, 'editor-undo').hasAttribute('disabled')).toBe(false)

    // 同 tag 连续输入合并：一次 undo 回到输入前（= 保存基线，脏标自动清）
    click(byTestId(mounted.container, 'editor-undo'))
    await flush()
    expect(titleValue(mounted.container)).toBe(initial)
    expect(byTestId(mounted.container, 'editor-undo').hasAttribute('disabled')).toBe(true)
    expect(byTestId(mounted.container, 'editor-save').textContent).not.toContain('*')

    // redo 恢复
    click(byTestId(mounted.container, 'editor-redo'))
    await flush()
    expect(titleValue(mounted.container)).toBe('第一版')
    await flush()
  })

  it('Ctrl+Z / Ctrl+Shift+Z 快捷键走同一撤销栈', async () => {
    const doc = await putLevelRecord('res_01J9V400000000000000000005', false)
    const mounted = mount(<EditorPageV4 id={doc.id} />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-editor"]') !== null)
    const initial = titleValue(mounted.container)
    await typeTitle(mounted.container, '快捷键标题')
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    })
    await flush()
    expect(titleValue(mounted.container)).toBe(initial)
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }))
    })
    await flush()
    expect(titleValue(mounted.container)).toBe('快捷键标题')
  })
})

describe('EditorPageV4 内置示例另存副本', () => {
  it('保存内置关 → 新 id +「（副本）」标题 + 原记录不变 + 路由/后续编辑跟随副本', async () => {
    const builtinId = 'res_01J9V4000000000000000000B1'
    await putLevelRecord(builtinId, true)
    const mounted = mount(<EditorPageV4 id={builtinId} />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-editor"]') !== null)
    await typeTitle(mounted.container, '内置示例关卡改')
    await clickSave(mounted.container)
    await flushUntil(() => mounted.container.querySelector('[data-testid="editor-saved-tip"]') !== null)

    // 原内置记录不被覆盖
    const original = await db.resources.get(builtinId)
    expect(original?.builtIn).toBe(1)
    expect(original?.version).toBe('1.0.0')
    // 新副本记录
    const all = await db.resources.toArray()
    const copy = all.find((record) => record.id !== builtinId && record.builtIn === 0)
    expect(copy).toBeTruthy()
    expect(String(copy?.title)).toBe('内置示例关卡改（副本）')
    expect(String(copy?.id)).toMatch(/^res_/)
    // 路由前移到副本
    expect(window.location.hash).toBe(`#/edit/${copy!.id}`)
    expect(byTestId(mounted.container, 'editor-saved-tip').textContent).toContain('副本')
    await flush()
    // 撤销栈身份重映射：undo 不会退回内置 id（标题仍含「（副本）」）
    click(byTestId(mounted.container, 'editor-undo'))
    await flush()
    expect(titleValue(mounted.container)).toContain('副本')
    await flush()
  })
})

describe('EditorPageV4 加载失败分支', () => {
  it('库内文档不是 v4 时给出可读错误（不白屏、可重试/返回）', async () => {
    const id = 'res_01J9V400000000000000000006'
    await db.resources.put({
      id,
      kind: 'level',
      version: '1.0.0',
      title: '旧格式关卡',
      doc: { schemaVersion: 3, kind: 'level', id, version: '1.0.0', meta: { title: '旧格式关卡' }, content: {} },
      importedAt: Date.now(),
      builtIn: 0,
    })
    const mounted = mount(<EditorPageV4 id={id} />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-load-error"]') !== null)
    expect(byTestId(mounted.container, 'v4-load-error').textContent).toContain('schemaVersion')
    expect(mounted.container.querySelector('a[href="#/library"]')).toBeTruthy()
    expect(mounted.container.textContent).toContain('重试')
  })
})

describe('EditorPageV4 草稿迁移（内置副本）', () => {
  it('另存副本后按 docId 键控的草稿迁移到新 id（JSON Tab 草稿不失联）', async () => {
    const builtinId = 'res_01J9V4000000000000000000B2'
    await putLevelRecord(builtinId, true)
    const mounted = mount(<EditorPageV4 id={builtinId} />)
    await flushUntil(() => mounted.container.querySelector('[data-testid="v4-editor"]') !== null)
    // 造一份 JSON 草稿（真实 UI 会写入；这里直接按契约写 draftStore）
    const { saveDraft } = await import('../draftStore')
    saveDraft(builtinId, `${'v4-json:'}level`, { text: '{"draft":true}', baselineSig: 'sig' })
    saveDraft(builtinId, DRAFT_SLOTS.jsonText, { text: '{}', baselineSig: 'sig' })
    await clickSave(mounted.container)
    await flushUntil(() => mounted.container.querySelector('[data-testid="editor-saved-tip"]') !== null)
    const all = await db.resources.toArray()
    const copy = all.find((record) => record.id !== builtinId && record.builtIn === 0)
    expect(copy).toBeTruthy()
    expect(loadDraft(copy!.id, `${'v4-json:'}level`)).toEqual({ text: '{"draft":true}', baselineSig: 'sig' })
    expect(loadDraft(copy!.id, DRAFT_SLOTS.jsonText)).toEqual({ text: '{}', baselineSig: 'sig' })
  })
})
