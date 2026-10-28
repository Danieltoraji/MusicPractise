// @vitest-environment jsdom
/**
 * v4 编辑器 Tab 交互测试（docs/52 §4 W5；jsdom 渲染各 Tab 的基础编辑）：
 * - V4EditorShell：6 个 Tab 锚点 / 占位插槽 / 标题 tag / 保存与撤销按钮接线 / lint 条；
 * - ContentTab：加题型/行、单元格编辑、行元数据、行重排、列增删改、JSON 兜底；
 * - ManifestTab：自动题单预览（草稿排除）、改显式、草稿警告、entry 增删排序、run 配置、牌堆预览；
 * - TypesTab：元信息、state/typeState/args、surface 组件与绑定；
 * - JsonTabV4：非法 JSON 拒绝且不污染 doc、分层应用、陈旧草稿门。
 * 关键断言：**改数据表不修改 flow**（引用相等，`next.content.flow === doc.content.flow`）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import type { LevelDocV4 } from '../../engine/v4/model'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import { newResourceId } from '../../library/id'
import { ContentTab } from './ContentTab'
import { JsonTabV4 } from './JsonTabV4'
import { ManifestTab } from './ManifestTab'
import { TypesTab } from './TypesTab'
import { V4EditorShell } from './V4EditorShell'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 每个用例独立文档 id：JsonTab 草稿按 docId 键控，避免用例间串档（draftStore 是模块级单例） */
function sampleDoc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.id = newResourceId()
  return doc
}

interface Mounted {
  container: HTMLElement
  rerender: (ui?: React.ReactElement) => void
  unmount: () => void
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  return {
    container,
    rerender: (next?: React.ReactElement) => {
      if (next) act(() => root.render(next))
    },
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`找不到锚点 ${testId}`)
  return el as HTMLElement
}

function click(el: Element | null): void {
  if (!el) throw new Error('点击目标不存在')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

const nativeInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
const nativeTextareaValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
const nativeSelectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!

/** 受控 input：native setter + input 事件（React value tracker 放行） */
function typeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    nativeInputValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function typeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    nativeTextareaValue.call(textarea, value)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function chooseSelect(select: HTMLSelectElement, value: string): void {
  act(() => {
    nativeSelectValue.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function blurInput(input: HTMLInputElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

/** 画布选中：down→up（W13 起选中在 pointerup 触发，避免拖拽中属性栏出现改变画布缩放） */
function pointerSelect(el: Element): void {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9, clientX: 10, clientY: 10 }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }))
  })
}

/** 受控文档 + onChange 捕获（模拟 EditorPageV4.update 的单向数据流） */
function harnessTab(
  Component: (props: { doc: LevelDocV4; onChange: (next: LevelDocV4, tag?: string) => void }) => React.ReactElement,
  initial: LevelDocV4,
): { mounted: Mounted; current: () => LevelDocV4; changes: () => LevelDocV4[]; tags: () => (string | undefined)[] } {
  let current = initial
  const changes: LevelDocV4[] = []
  const tags: (string | undefined)[] = []
  const render = (): React.ReactElement => (
    <Component
      doc={current}
      onChange={(next, tag) => {
        changes.push(next)
        tags.push(tag)
        current = next
      }}
    />
  )
  const mounted = mount(render())
  return {
    mounted: {
      ...mounted,
      rerender: () => mounted.rerender(render()),
    },
    current: () => current,
    changes: () => changes,
    tags: () => tags,
  }
}

// ---------------------------------------------------------------------------
// V4EditorShell
// ---------------------------------------------------------------------------

describe('V4EditorShell（Tab 框架与宿主接线）', () => {
  it('渲染 6 个 Tab 锚点 + 标题/撤销/重做/保存/试运行/AI 开关', () => {
    const doc = sampleDoc()
    const calls: { tag?: string }[] = []
    let saveCount = 0
    const mounted = mount(
      <V4EditorShell
        doc={doc}
        onChange={(_next, tag) => calls.push({ tag })}
        onSave={() => {
          saveCount += 1
        }}
        dirty
        revision={7}
        lintWarnings={['示例 lint 警告']}
        canUndo={false}
        canRedo={false}
      />,
    )
    try {
      for (const tab of ['content', 'flow', 'types', 'shell', 'preview', 'json']) {
        expect(byTestId(mounted.container, `editor-tab-${tab}`)).toBeTruthy()
      }
      expect(byTestId(mounted.container, 'editor-title')).toBeTruthy()
      expect(byTestId(mounted.container, 'editor-undo').hasAttribute('disabled')).toBe(true)
      expect(byTestId(mounted.container, 'editor-redo').hasAttribute('disabled')).toBe(true)
      expect(byTestId(mounted.container, 'editor-save').textContent).toContain('*')
      expect(byTestId(mounted.container, 'v4-editor-revision').textContent).toContain('7')
      expect(byTestId(mounted.container, 'editor-lint').textContent).toContain('示例 lint 警告')
      // 标题逐键输入带 tag='title'（撤销栈合并）
      typeInput(byTestId(mounted.container, 'editor-title') as HTMLInputElement, '改标题')
      expect(calls.at(-1)?.tag).toBe('title')
      click(byTestId(mounted.container, 'editor-save'))
      expect(saveCount).toBe(1)
    } finally {
      mounted.unmount()
    }
  })

  it('默认内容 Tab 渲染 ContentTab；flow/shell/preview 显示占位（W6/W7 槽位可注入）', () => {
    const doc = sampleDoc()
    const mounted = mount(
      <V4EditorShell doc={doc} onChange={() => undefined} onSave={() => undefined} dirty={false} revision={0} lintWarnings={[]} />,
    )
    try {
      expect(byTestId(mounted.container, 'v4-content-tab')).toBeTruthy()
      click(byTestId(mounted.container, 'editor-tab-flow'))
      expect(byTestId(mounted.container, 'v4-flow-placeholder')).toBeTruthy()
      click(byTestId(mounted.container, 'editor-tab-shell'))
      expect(byTestId(mounted.container, 'v4-shell-placeholder')).toBeTruthy()
      click(byTestId(mounted.container, 'editor-tab-preview'))
      expect(byTestId(mounted.container, 'v4-preview-placeholder')).toBeTruthy()
      click(byTestId(mounted.container, 'editor-tab-types'))
      expect(byTestId(mounted.container, 'v4-types-tab')).toBeTruthy()
      click(byTestId(mounted.container, 'editor-tab-json'))
      expect(byTestId(mounted.container, 'v4-json-tab')).toBeTruthy()
      // AI 面板占位随开关显隐
      expect(byTestId(mounted.container, 'v4-ai-panel')).toBeTruthy()
      click(byTestId(mounted.container, 'editor-ai-toggle'))
      expect(mounted.container.querySelector('[data-testid="v4-ai-panel"]')).toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('槽位注入后替换占位（W6/W7 接入契约）', () => {
    const doc = sampleDoc()
    const mounted = mount(
      <V4EditorShell
        doc={doc}
        onChange={() => undefined}
        onSave={() => undefined}
        dirty={false}
        revision={3}
        lintWarnings={[]}
        renderFlow={({ revision }) => <div data-testid="flow-slot">flow slot rev {revision}</div>}
        renderShell={() => <div data-testid="shell-slot">shell slot</div>}
        renderPreview={() => <div data-testid="preview-slot">preview slot</div>}
      />,
    )
    try {
      click(byTestId(mounted.container, 'editor-tab-flow'))
      expect(byTestId(mounted.container, 'flow-slot').textContent).toContain('rev 3')
      click(byTestId(mounted.container, 'editor-tab-shell'))
      expect(byTestId(mounted.container, 'shell-slot')).toBeTruthy()
      click(byTestId(mounted.container, 'editor-tab-preview'))
      expect(byTestId(mounted.container, 'preview-slot')).toBeTruthy()
    } finally {
      mounted.unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// ContentTab
// ---------------------------------------------------------------------------

describe('ContentTab（题型实例表）', () => {
  it('从零建题型 → 加行 → 编辑单元格：改数据表不修改 flow（引用相等）', () => {
    const blank = sampleDoc()
    // 清空题型/表，验证空态入口
    blank.content.types = []
    blank.content.tables = {}
    const harness = harnessTab(ContentTab, blank)
    try {
      const { container } = harness.mounted
      expect(byTestId(container, 'v4-tables-empty')).toBeTruthy()
      click(byTestId(container, 'v4-content-add-type'))
      harness.mounted.rerender()
      const afterType = harness.current()
      expect(afterType.content.types).toHaveLength(1)
      expect(afterType.content.flow).toBe(blank.content.flow)

      click(byTestId(container, 'v4-tgrid-add-row'))
      harness.mounted.rerender()
      const afterRow = harness.current()
      const typeId = afterRow.content.types[0].id
      const table = afterRow.content.tables[typeId]
      expect(table.rows).toHaveLength(1)
      expect(afterRow.content.flow).toBe(blank.content.flow)
      const rowId = table.rows[0].id

      // 文本单元格逐键提交（tag='cell'）
      const cell = byTestId(container, `v4-tgrid-cell-${rowId}-prompt`) as HTMLInputElement
      typeInput(cell, '第一题')
      harness.mounted.rerender()
      const afterCell = harness.current()
      expect(afterCell.content.tables[typeId].rows[0].prompt).toBe('第一题')
      expect(harness.tags().at(-1)).toBe('cell')
      // 数据表变换不触碰 flow / shell / types
      expect(afterCell.content.flow).toBe(blank.content.flow)
      expect(afterCell.content.shell).toBe(blank.content.shell)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('行元数据（draft/phase/order）、行重排、删行', () => {
    const doc = sampleDoc()
    const harness = harnessTab(ContentTab, doc)
    try {
      const { container } = harness.mounted
      const typeId = 'choice'
      // draft 勾选 → 不入自动题单（后续 ManifestTab 断言）
      const draftBox = byTestId(container, 'v4-row-draft-row_01') as HTMLInputElement
      click(draftBox)
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].rows[0].draft).toBe(true)
      expect(harness.tags().at(-1)).toBe('row-meta')
      // phase / order
      const phase = byTestId(container, 'v4-row-phase-row_01') as HTMLInputElement
      typeInput(phase, '2')
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].rows[0].phase).toBe(2)
      const order = byTestId(container, 'v4-row-order-row_01') as HTMLInputElement
      typeInput(order, '9')
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].rows[0].order).toBe(9)
      // 行重排：row_02 上移
      click(byTestId(container, 'v4-row-up-row_02'))
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].rows.map((row) => row.id).slice(0, 2)).toEqual([
        'row_02',
        'row_01',
      ])
      expect(harness.current().content.flow).toBe(doc.content.flow)
      // 删行
      click(byTestId(container, 'v4-row-remove-row_02'))
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].rows.some((row) => row.id === 'row_02')).toBe(false)
      expect(harness.current().content.flow).toBe(doc.content.flow)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('列：新增 / 重命名（blur 提交）/ 类型切换 / 删除', () => {
    const doc = sampleDoc()
    const harness = harnessTab(ContentTab, doc)
    try {
      const { container } = harness.mounted
      const typeId = 'choice'
      // 新增列
      const newCol = byTestId(container, 'v4-col-new') as HTMLInputElement
      typeInput(newCol, 'answer')
      click(byTestId(container, 'v4-col-add'))
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].columns.map((c) => c.key)).toContain('answer')
      expect(harness.current().content.tables[typeId].rows[0].answer).toBeNull()
      expect(harness.current().content.flow).toBe(doc.content.flow)
      // 类型切换（list）
      chooseSelect(byTestId(container, 'v4-col-type-answer') as HTMLSelectElement, 'list')
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].columns.find((c) => c.key === 'answer')?.type).toBe('list')
      // 重命名列（onBlur 提交）
      const keyInput = byTestId(container, 'v4-col-key-answer') as HTMLInputElement
      act(() => {
        nativeInputValue.call(keyInput, 'choices')
        keyInput.dispatchEvent(new Event('input', { bubbles: true }))
      })
      blurInput(keyInput)
      harness.mounted.rerender()
      const afterRename = harness.current().content.tables[typeId]
      expect(afterRename.columns.map((c) => c.key)).toContain('choices')
      expect(afterRename.rows[0].choices).toBeNull()
      // 显示名
      const labelInput = byTestId(container, 'v4-col-label-choices') as HTMLInputElement
      act(() => {
        nativeInputValue.call(labelInput, '选项')
      })
      blurInput(labelInput)
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].columns.find((c) => c.key === 'choices')?.label).toBe('选项')
      // 删除列
      click(byTestId(container, 'v4-col-remove-choices'))
      harness.mounted.rerender()
      expect(harness.current().content.tables[typeId].columns.some((c) => c.key === 'choices')).toBe(false)
      expect(harness.current().content.flow).toBe(doc.content.flow)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('非标量单元格回落 JsonFallback：弹窗修正 JSON', () => {
    const doc = sampleDoc()
    // 给 text 列塞对象值（模拟历史脏数据）
    doc.content.tables.choice.rows[0].prompt = { nested: 1 } as never
    const harness = harnessTab(ContentTab, doc)
    try {
      const { container } = harness.mounted
      const fix = byTestId(container, 'v4-tgrid-cell-row_01-prompt-fix')
      click(fix)
      expect(byTestId(container, 'v4-json-cell-text')).toBeTruthy()
      typeTextarea(byTestId(container, 'v4-json-cell-text') as HTMLTextAreaElement, '"修正后的题面"')
      click(byTestId(container, 'v4-json-cell-apply'))
      harness.mounted.rerender()
      expect(harness.current().content.tables.choice.rows[0].prompt).toBe('修正后的题面')
    } finally {
      harness.mounted.unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// ManifestTab
// ---------------------------------------------------------------------------

describe('ManifestTab（自动/显式题单 + run + 牌堆）', () => {
  it('自动题单预览排除草稿行，并显示排序信息', () => {
    const doc = sampleDoc()
    const harness = harnessTab(ManifestTab, doc)
    try {
      const { container } = harness.mounted
      // fixtures：3 行其中 row_03 draft → 自动题单 2 项
      expect(container.querySelectorAll('[data-testid^="v4-auto-slot-"]').length).toBe(2)
      expect(byTestId(container, 'v4-manifest-auto').textContent).toContain('草稿行已排除')
      expect(byTestId(container, 'v4-deck-preview').textContent).toContain('自动题单')
    } finally {
      harness.mounted.unmount()
    }
  })

  it('改为显式题单 → 草稿引用警告 → entry 增删排序与 args', () => {
    const doc = sampleDoc()
    // 先造显式题单包含草稿行，验证警告
    doc.content.manifest = { entries: [{ type: 'choice', row: 'row_01' }, { type: 'choice', row: 'row_03' }] }
    const harness = harnessTab(ManifestTab, doc)
    try {
      const { container } = harness.mounted
      expect(byTestId(container, 'v4-manifest-draft-warning').textContent).toContain('草稿行')
      expect(container.querySelectorAll('[data-testid^="v4-manifest-entry-"]').length).toBe(2)
      // 下移第 1 项 → 顺序交换
      click(byTestId(container, 'v4-manifest-down-0'))
      harness.mounted.rerender()
      expect(harness.current().content.manifest?.entries.map((e) => e.row)).toEqual(['row_03', 'row_01'])
      // 移除第 2 项
      click(byTestId(container, 'v4-manifest-remove-1'))
      harness.mounted.rerender()
      expect(harness.current().content.manifest?.entries).toHaveLength(1)
      // 恢复自动题单
      click(byTestId(container, 'v4-manifest-clear'))
      harness.mounted.rerender()
      expect(harness.current().content.manifest).toBeUndefined()
      expect(harness.current().content.flow).toBe(doc.content.flow)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('自动 → 显式（以自动题单为初稿）→ args 编辑', () => {
    const doc = sampleDoc()
    const harness = harnessTab(ManifestTab, doc)
    try {
      const { container } = harness.mounted
      click(byTestId(container, 'v4-manifest-make-explicit'))
      harness.mounted.rerender()
      const entries = harness.current().content.manifest?.entries ?? []
      expect(entries.map((entry) => entry.row)).toEqual(['row_01', 'row_02'])
      // args 弹窗：填对象后应用
      click(byTestId(container, 'v4-manifest-args-0'))
      typeTextarea(byTestId(container, 'v4-manifest-args-text') as HTMLTextAreaElement, '{"difficulty":2}')
      click(byTestId(container, 'v4-manifest-args-apply'))
      harness.mounted.rerender()
      expect(harness.current().content.manifest?.entries[0].args).toEqual({ difficulty: 2 })
      // 非法 JSON 不应用（弹窗保持，错误可见）
      click(byTestId(container, 'v4-manifest-args-0'))
      typeTextarea(byTestId(container, 'v4-manifest-args-text') as HTMLTextAreaElement, '{bad')
      click(byTestId(container, 'v4-manifest-args-apply'))
      expect(byTestId(container, 'v4-manifest-args-error')).toBeTruthy()
      expect(harness.current().content.manifest?.entries[0].args).toEqual({ difficulty: 2 })
    } finally {
      harness.mounted.unmount()
    }
  })

  it('run 配置编辑：order/count/seed/阶段内洗牌；固定 seed 时牌堆可复现', () => {
    const doc = sampleDoc()
    const harness = harnessTab(ManifestTab, doc)
    try {
      const { container } = harness.mounted
      chooseSelect(byTestId(container, 'v4-run-order') as HTMLSelectElement, 'shuffle')
      harness.mounted.rerender()
      expect(harness.current().content.run.order).toBe('shuffle')
      typeInput(byTestId(container, 'v4-run-count') as HTMLInputElement, '1')
      harness.mounted.rerender()
      expect(harness.current().content.run.count).toBe(1)
      typeInput(byTestId(container, 'v4-run-seed') as HTMLInputElement, '42')
      harness.mounted.rerender()
      expect(harness.current().content.run.seed).toBe(42)
      // 固定 seed 下牌堆只有 1 张且「换一局」禁用
      expect(byTestId(container, 'v4-deck-preview').textContent).toContain('seed 42')
      expect(byTestId(container, 'v4-deck-reshuffle').hasAttribute('disabled')).toBe(true)
      expect(container.querySelectorAll('[data-testid^="v4-deck-slot-"]').length).toBe(1)
      // 清空 seed → null 并允许重新随机预览
      typeInput(byTestId(container, 'v4-run-seed') as HTMLInputElement, '')
      harness.mounted.rerender()
      expect(harness.current().content.run.seed).toBeNull()
      expect(byTestId(container, 'v4-deck-reshuffle').hasAttribute('disabled')).toBe(false)
    } finally {
      harness.mounted.unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// TypesTab
// ---------------------------------------------------------------------------

describe('TypesTab（元信息 / state / surface）', () => {
  it('元信息编辑走 onChange；id 只读', () => {
    const doc = sampleDoc()
    const harness = harnessTab(TypesTab, doc)
    try {
      const { container } = harness.mounted
      expect(byTestId(container, 'v4-type-id').textContent).toBe('choice')
      typeInput(byTestId(container, 'v4-type-name') as HTMLInputElement, '听音选择·改')
      harness.mounted.rerender()
      expect(harness.current().content.types[0].name).toBe('听音选择·改')
      typeTextarea(byTestId(container, 'v4-type-description') as HTMLTextAreaElement, '新的说明')
      harness.mounted.rerender()
      expect(harness.current().content.types[0].description).toBe('新的说明')
      // 元信息变换不触碰 flow
      expect(harness.current().content.flow).toBe(doc.content.flow)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('state/typeState/args：加字段、切类型重置初值、删字段', () => {
    const doc = sampleDoc()
    const harness = harnessTab(TypesTab, doc)
    try {
      const { container } = harness.mounted
      click(byTestId(container, 'v4-type-subtab-state'))
      // state 加字段
      click(byTestId(container, 'v4-state-add-state'))
      harness.mounted.rerender()
      const stateFields = harness.current().content.types[0].state ?? []
      expect(stateFields.length).toBe(2)
      expect(stateFields[1].type).toBe('number')
      expect(stateFields[1].init).toBe(0)
      // 切到 boolean → init 重置 false
      chooseSelect(byTestId(container, 'v4-state-type-state-1') as HTMLSelectElement, 'boolean')
      harness.mounted.rerender()
      expect(harness.current().content.types[0].state?.[1]).toMatchObject({ type: 'boolean', init: false })
      // typeState 加字段
      click(byTestId(container, 'v4-state-add-typeState'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].typeState).toHaveLength(2)
      // args 加字段（无 init，带 optional/default 编辑）
      click(byTestId(container, 'v4-state-add-args'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].args).toHaveLength(2)
      click(byTestId(container, 'v4-state-optional-args-1'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].args?.[1].optional).toBe(true)
      // 删除 state 第二个字段
      click(byTestId(container, 'v4-state-remove-state-1'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].state).toHaveLength(1)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('surface 画布：真实组件预览 / 预览行 / 新增 / 布局 / 绑定 / 删除', () => {
    const doc = sampleDoc()
    const harness = harnessTab(TypesTab, doc)
    try {
      const { container } = harness.mounted
      click(byTestId(container, 'v4-type-subtab-surface'))
      // 与 shell 画布同源的画布骨架 + 题型已有两个组件
      expect(byTestId(container, 'v4-type-surface')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas').getAttribute('data-layer')).toBe('surface')
      expect(byTestId(container, 'v4-canvas-palette')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas-stage')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas-box-prompt')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas-box-choice1')).toBeTruthy()
      // 绑定按 surface 层根求值：q.prompt 取预览行（默认首条非草稿行）
      expect(byTestId(container, 'v4-canvas-box-prompt').textContent).toContain('听一听，这是什么音？')
      // 预览行切换 → 画布内真实组件内容跟着变
      chooseSelect(byTestId(container, 'v4-canvas-preview-row') as HTMLSelectElement, 'row_02')
      expect(byTestId(container, 'v4-canvas-box-prompt').textContent).toContain('再听一个')

      const before = harness.current().content.types[0].surface.components.length
      click(byTestId(container, 'v4-canvas-add-label'))
      harness.mounted.rerender()
      const components = harness.current().content.types[0].surface.components
      expect(components.length).toBe(before + 1)
      const added = components[components.length - 1]
      expect(added.id.length).toBeGreaterThan(0)
      expect(added.view).toBeUndefined() // 未声明题内视图时不带 view
      expect(added.layout?.x).toBeLessThan(800)
      // 选中新组件 → 检查器布局编辑
      typeInput(byTestId(container, 'v4-canvas-layout-x') as HTMLInputElement, '33')
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.components.at(-1)!.layout!.x).toBe(33)
      // 绑定（surface 只读投影：q.* 合法；label 有 text 槽位）
      click(byTestId(container, 'v4-canvas-binding-add'))
      harness.mounted.rerender()
      typeInput(byTestId(container, 'v4-canvas-binding-expr-text') as HTMLInputElement, 'q.prompt')
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.components.at(-1)!.bindings).toEqual({ text: 'q.prompt' })
      // 删除组件
      click(byTestId(container, 'v4-canvas-remove'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.components.length).toBe(before)
      // 数据/表现编辑不触碰 flow
      expect(harness.current().content.flow).toBe(doc.content.flow)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('题内视图：经画布视图条新增 / 归属 / 设初始 / 命名 / 删除（v4.1）', () => {
    const doc = sampleDoc()
    const harness = harnessTab(TypesTab, doc)
    try {
      const { container } = harness.mounted
      click(byTestId(container, 'v4-type-subtab-surface'))

      // 新增视图 → 画布切到新视图（常驻组件仍可见，无视图专属组件）
      click(byTestId(container, 'v4-canvas-view-add'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.views?.map((view) => view.id)).toEqual(['view1'])
      expect(byTestId(container, 'v4-canvas-view-view1')).toBeTruthy()

      // 有视图时新增组件默认归入当前视图
      click(byTestId(container, 'v4-canvas-add-label'))
      harness.mounted.rerender()
      const added = harness.current().content.types[0].surface.components.at(-1)!
      expect(added.view).toBe('view1')
      // 检查器可改为「全部视图（常驻）」
      chooseSelect(byTestId(container, 'v4-canvas-view-field') as HTMLSelectElement, '')
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.components.at(-1)!.view).toBeUndefined()

      // 选中已有组件并指派视图归属（画布点选 = pointerup）
      pointerSelect(byTestId(container, 'v4-canvas-box-prompt'))
      harness.mounted.rerender()
      chooseSelect(byTestId(container, 'v4-canvas-view-field') as HTMLSelectElement, 'view1')
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.components[0].view).toBe('view1')

      // 新增第二个视图 → 可将「非首视图」设为显式初始视图
      click(byTestId(container, 'v4-canvas-view-add'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.views?.map((view) => view.id)).toEqual(['view1', 'view2'])
      click(byTestId(container, 'v4-canvas-view-initial-view2'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.initialView).toBe('view2')

      // 视图改名（逐键写入，tag 合并）
      typeInput(byTestId(container, 'v4-canvas-view-name-view1') as HTMLInputElement, '作答')
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.views?.[0].name).toBe('作答')

      // 删除视图：组件不删、归属清空、initialView 清除；删到 0 回到「无题内视图」形态
      click(byTestId(container, 'v4-canvas-view-remove-view2'))
      harness.mounted.rerender()
      expect(harness.current().content.types[0].surface.views?.map((view) => view.id)).toEqual(['view1'])
      expect(harness.current().content.types[0].surface.initialView).toBeUndefined()
      click(byTestId(container, 'v4-canvas-view-remove-view1'))
      harness.mounted.rerender()
      const surface = harness.current().content.types[0].surface
      expect(surface.views).toBeUndefined()
      expect(surface.initialView).toBeUndefined()
      expect(surface.components[0].view).toBeUndefined()
      expect(surface.components.at(-1)!.view).toBeUndefined()
      expect(harness.current().content.flow).toBe(doc.content.flow)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('行为子页缺省占位；注入 renderBehavior 后渲染（W6 接入契约）', () => {
    const doc = sampleDoc()
    const mounted = mount(
      <TypesTab
        doc={doc}
        onChange={() => undefined}
        renderBehavior={({ typeId, revision }) => (
          <div data-testid="behavior-slot">
            {typeId} rev {revision}
          </div>
        )}
        revision={5}
      />,
    )
    try {
      click(byTestId(mounted.container, 'v4-type-subtab-behavior'))
      expect(byTestId(mounted.container, 'behavior-slot').textContent).toContain('choice rev 5')
    } finally {
      mounted.unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// JsonTabV4
// ---------------------------------------------------------------------------

describe('JsonTabV4（分层 JSON + 陈旧门）', () => {
  it('非法 JSON 拒绝应用且不污染 doc', () => {
    const doc = sampleDoc()
    const harness = harnessTab(JsonTabV4, doc)
    try {
      const { container } = harness.mounted
      typeTextarea(byTestId(container, 'v4-json-textarea') as HTMLTextAreaElement, '{ not valid json')
      click(byTestId(container, 'v4-json-apply'))
      expect(byTestId(container, 'v4-json-error').textContent).toContain('不是合法 JSON')
      expect(harness.changes()).toHaveLength(0)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('结构非法的层拒绝应用（走 loadLevelDocV4 全量预检）', () => {
    const doc = sampleDoc()
    const harness = harnessTab(JsonTabV4, doc)
    try {
      const { container } = harness.mounted
      // flow 层塞入缺失 start 的图
      chooseSelect(byTestId(container, 'v4-json-layer') as HTMLSelectElement, 'flow')
      harness.mounted.rerender()
      const flow = JSON.parse((byTestId(container, 'v4-json-textarea') as HTMLTextAreaElement).value) as {
        nodes: unknown[]
        edges: unknown[]
      }
      flow.nodes = flow.nodes.filter((node) => (node as { kind?: string }).kind !== 'start')
      typeTextarea(byTestId(container, 'v4-json-textarea') as HTMLTextAreaElement, JSON.stringify(flow, null, 2))
      click(byTestId(container, 'v4-json-apply'))
      expect(byTestId(container, 'v4-json-error').textContent).toContain('start')
      expect(harness.changes()).toHaveLength(0)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('分层应用 flow：合法 JSON 走 onChange（tag=json），doc 的 id/version 不变', () => {
    const doc = sampleDoc()
    const harness = harnessTab(JsonTabV4, doc)
    try {
      const { container } = harness.mounted
      chooseSelect(byTestId(container, 'v4-json-layer') as HTMLSelectElement, 'flow')
      harness.mounted.rerender()
      const textarea = byTestId(container, 'v4-json-textarea') as HTMLTextAreaElement
      const flow = JSON.parse(textarea.value) as { vars?: unknown[] }
      flow.vars = []
      typeTextarea(textarea, JSON.stringify(flow, null, 2))
      click(byTestId(container, 'v4-json-apply'))
      harness.mounted.rerender()
      expect(harness.changes().length).toBe(1)
      expect(harness.tags().at(-1)).toBe('json')
      const next = harness.current()
      expect(next.id).toBe(doc.id)
      expect(next.version).toBe(doc.version)
      expect(next.content.flow.vars).toEqual([])
    } finally {
      harness.mounted.unmount()
    }
  })

  it('整关卡层应用：保留 id/version，改 meta 走 onChange；非对象拒绝', () => {
    const doc = sampleDoc()
    const harness = harnessTab(JsonTabV4, doc)
    try {
      const { container } = harness.mounted
      const textarea = byTestId(container, 'v4-json-textarea') as HTMLTextAreaElement
      const whole = JSON.parse(textarea.value) as { meta: { title: string } }
      whole.meta.title = 'JSON 改的标题'
      typeTextarea(textarea, JSON.stringify(whole, null, 2))
      click(byTestId(container, 'v4-json-apply'))
      harness.mounted.rerender()
      expect(harness.changes()).toHaveLength(1)
      const next = harness.current()
      expect(next.meta.title).toBe('JSON 改的标题')
      expect(next.id).toBe(doc.id)
      expect(next.version).toBe(doc.version)
      // 非对象整关卡 JSON 拒绝
      typeTextarea(textarea, '[1,2,3]')
      click(byTestId(container, 'v4-json-apply'))
      expect(byTestId(container, 'v4-json-error').textContent).toContain('必须')
      expect(harness.changes()).toHaveLength(1)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('陈旧草稿门：外部修改后禁用应用，重新生成后恢复', () => {
    const doc = sampleDoc()
    let current = doc
    const changes: LevelDocV4[] = []
    const render = (): React.ReactElement => (
      <JsonTabV4
        doc={current}
        onChange={(next) => {
          changes.push(next)
          current = next
        }}
      />
    )
    const mounted = mount(render())
    try {
      const { container } = mounted
      // 草稿文本被修改
      typeTextarea(byTestId(container, 'v4-json-textarea') as HTMLTextAreaElement, JSON.stringify({ ...doc, meta: { title: '草稿标题' } }, null, 2))
      // 外部修改文档（模拟 AI/其它 Tab/undo）→ 签名失配
      current = { ...doc, meta: { ...doc.meta, title: '外部标题' } }
      mounted.rerender(render())
      expect(byTestId(container, 'v4-json-stale')).toBeTruthy()
      expect(byTestId(container, 'v4-json-apply').hasAttribute('disabled')).toBe(true)
      // 从当前文档重新生成 → 恢复可应用
      click(byTestId(container, 'v4-json-regenerate'))
      expect(container.querySelector('[data-testid="v4-json-stale"]')).toBeNull()
      expect(byTestId(container, 'v4-json-apply').hasAttribute('disabled')).toBe(false)
      expect((byTestId(container, 'v4-json-textarea') as HTMLTextAreaElement).value).toContain('外部标题')
      expect(changes).toHaveLength(0)
    } finally {
      mounted.unmount()
    }
  })
})
