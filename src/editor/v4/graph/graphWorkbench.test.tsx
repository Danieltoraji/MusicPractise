// @vitest-environment jsdom
/**
 * v4 图工作台 UI（jsdom）测试（docs/52 W6 / docs/53 §13.4）：
 * - 渲染：节点卡（kind 标签 + 伪代码摘要）、调色板分组、变量面板、检查器占位；
 * - 建图：调色板插入节点 / 右键菜单插入 / 同一 task 连续编辑单基线不丢前一笔；
 * - 改参：选中节点 → 检查器表达式字段提交 → onChange(next, 'flow')；
 * - 删除：选中节点后 Delete（window 监听）级联删边；
 * - 行为层：surface 组件事件自动进入 on 候选、多 handler 增删、tag='behavior'；
 * - 伪代码视图：工作台内切换、文本应用回节点图、语法错误就地提示且不改文档；
 * - 主题：`.ge-dark`/`.ge-light` 切换（localStorage graph-theme）。
 *
 * jsdom 下 React Flow 需要容器宽高（v3 graphEditorUi.test 同口径：offsetWidth/offsetHeight 固定）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, describe, expect, it } from 'vitest'
import type { LevelDocV4 } from '../../../engine/v4/model'
import { minimalLevelDoc } from '../../../engine/v4/fixtures'
import { newResourceId } from '../../../library/id'
import { V4EditorShell } from '../V4EditorShell'
import { BehaviorGraphSlot, FlowGraphSlot } from './GraphWorkbench'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1200 })
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 700 })
})

/** 每个用例独立文档 id（伪代码草稿按 docId+layer 键控，避免用例间串档） */
function sampleDoc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.id = newResourceId()
  return doc
}

interface Harness {
  container: HTMLElement
  current: () => LevelDocV4
  changes: () => LevelDocV4[]
  tags: () => (string | undefined)[]
  rerender: () => void
  unmount: () => void
}

function mountSlot(slot: 'flow' | 'behavior', initial: LevelDocV4, typeId?: string): Harness {
  let current = initial
  const changes: LevelDocV4[] = []
  const tags: (string | undefined)[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  const onChange = (next: LevelDocV4, tag?: string): void => {
    changes.push(next)
    tags.push(tag)
    current = next
  }
  const render = (): React.ReactElement =>
    slot === 'flow' ? (
      <FlowGraphSlot doc={current} revision={1} onChange={onChange} />
    ) : (
      <BehaviorGraphSlot doc={current} revision={1} typeId={typeId ?? ''} onChange={onChange} />
    )
  act(() => {
    root = createRoot(container)
    root.render(render())
  })
  return {
    container,
    current: () => current,
    changes: () => changes,
    tags: () => tags,
    rerender: () => act(() => root.render(render())),
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const element = container.querySelector(`[data-testid="${testId}"]`)
  if (!element) throw new Error(`找不到锚点 ${testId}`)
  return element as HTMLElement
}

function hasTestId(container: HTMLElement, testId: string): boolean {
  return container.querySelector(`[data-testid="${testId}"]`) !== null
}

function click(element: Element | null): void {
  if (!element) throw new Error('点击目标不存在')
  act(() => {
    ;(element as HTMLElement).click()
  })
}

const nativeInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
const nativeTextareaValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
const nativeSelectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!

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

function blurInput(input: HTMLElement): void {
  act(() => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

function nodeIds(doc: LevelDocV4): string[] {
  return doc.content.flow.nodes.map((node) => node.id)
}

describe('v4 GraphWorkbench · flow 渲染与建图', () => {
  it('渲染工作台/节点卡/调色板/变量面板与检查器占位', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      const root = byTestId(harness.container, 'v4-graph-workbench')
      expect(root.getAttribute('data-layer')).toBe('flow')
      expect(root.className).toContain('ge-dark')
      // 节点卡：kind 中文名 + 伪代码摘要
      expect(hasTestId(harness.container, 'graph-card-f_start')).toBe(true)
      const initCard = byTestId(harness.container, 'graph-card-f_init')
      expect(initCard.textContent).toContain('赋值')
      expect(initCard.textContent).toContain('v.score = 0')
      expect(hasTestId(harness.container, 'graph-card-f_finish')).toBe(true)
      // 调色板：已有 start 时不再提供 start 项
      expect(hasTestId(harness.container, 'palette-item-flow-branch')).toBe(true)
      expect(hasTestId(harness.container, 'palette-item-flow-ask')).toBe(true)
      expect(hasTestId(harness.container, 'palette-item-flow-start')).toBe(false)
      // 变量面板展示 flow.vars
      expect(byTestId(harness.container, 'v4-graph-vars').textContent).toContain('v.score')
      // 未选中节点：检查器为空态
      expect(byTestId(harness.container, 'v4-graph-inspector').textContent).toContain('选中一个节点')
    } finally {
      harness.unmount()
    }
  })

  it('调色板插入节点：onChange(next, tag=flow)，落点带 x/y', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      click(byTestId(harness.container, 'palette-item-flow-branch'))
      expect(harness.tags()).toEqual(['flow'])
      const flow = harness.current().content.flow
      expect(flow.nodes).toHaveLength(4)
      const added = flow.nodes.at(-1)!
      expect(added.kind).toBe('branch')
      expect(added.id).toMatch(/^branch_/)
      expect(added.x).toBeTypeOf('number')
      expect(added.y).toBeTypeOf('number')
      // 受控回流后画布出现新节点卡
      harness.rerender()
      expect(hasTestId(harness.container, `graph-card-${added.id}`)).toBe(true)
    } finally {
      harness.unmount()
    }
  })

  it('同一 task 内连续两次调色板插入：单基线不丢前一笔（O9）', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      const button = byTestId(harness.container, 'palette-item-flow-wait')
      act(() => {
        button.click()
        button.click()
      })
      expect(harness.changes()).toHaveLength(2)
      expect(harness.changes()[0].content.flow.nodes).toHaveLength(4)
      // 第二次提交必须包含第一次新增的节点（基线 = pending doc，而非过期 prop）
      expect(harness.changes()[1].content.flow.nodes).toHaveLength(5)
      expect(harness.tags()).toEqual(['flow', 'flow'])
    } finally {
      harness.unmount()
    }
  })

  it('右键画布空白：调色板菜单可插入节点', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      const pane = harness.container.querySelector('.react-flow__pane')
      expect(pane).toBeTruthy()
      act(() => {
        pane!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 120 }))
      })
      expect(hasTestId(harness.container, 'v4-graph-palette-menu')).toBe(true)
      click(byTestId(harness.container, 'palette-menu-item-flow-comment'))
      expect(harness.tags()).toEqual(['flow'])
      const added = harness.current().content.flow.nodes.at(-1)!
      expect(added.kind).toBe('comment')
      expect(hasTestId(harness.container, 'v4-graph-palette-menu')).toBe(false)
    } finally {
      harness.unmount()
    }
  })
})

describe('v4 GraphWorkbench · flow 检查器/删除/变量', () => {
  it('选中节点 → 检查器改表达式（实时校验 DOM + 失焦提交 tag=flow）', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      click(byTestId(harness.container, 'graph-card-f_init'))
      const inspector = byTestId(harness.container, 'v4-graph-inspector')
      expect(inspector.textContent).toContain('赋值')
      const input = byTestId(harness.container, 'v4-graph-field-expr') as HTMLInputElement
      expect(input.value).toBe('0')
      // 非法表达式：就地报错、不提交
      typeInput(input, 'v.score +')
      expect(byTestId(harness.container, 'v4-graph-field-error')).toBeTruthy()
      blurInput(input)
      expect(harness.changes()).toHaveLength(0)
      // 合法表达式：失焦提交
      typeInput(input, 'v.score + 5')
      expect(harness.container.querySelector('[data-testid="v4-graph-field-error"]')).toBeNull()
      blurInput(input)
      expect(harness.tags()).toEqual(['flow'])
      const flow = harness.current().content.flow
      const assign = flow.nodes.find((node) => node.id === 'f_init') as { value: { expr: string } }
      expect(assign.value.expr).toBe('v.score + 5')
      // 数据表/flow 结构共享：其它分支未被复制改写（只换 flow 分支）
      expect(harness.current().content.shell).toBe(harness.current().content.shell)
    } finally {
      harness.unmount()
    }
  })

  it('选中节点后 Delete：删除节点并级联删除其连线（tag=flow）', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      click(byTestId(harness.container, 'graph-card-f_init'))
      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
      })
      expect(harness.tags()).toEqual(['flow'])
      expect(nodeIds(harness.current())).toEqual(['f_start', 'f_finish'])
      expect(harness.current().content.flow.edges).toHaveLength(0)
    } finally {
      harness.unmount()
    }
  })

  it('lint 呈现：非法表达式节点红标，问题列表可点击定位', () => {
    const doc = sampleDoc()
    // 流程层使用行为层专属根 event.* → lint 报 V4_EXPR_ROOT（finish passed 的 lint 定位带 nodeId）
    doc.content.flow.nodes = doc.content.flow.nodes.map((node) =>
      node.id === 'f_finish' ? { ...node, passed: 'event.score' } : node,
    )
    const harness = mountSlot('flow', doc)
    try {
      const card = byTestId(harness.container, 'graph-card-f_finish')
      expect(card.className).toContain('has-error')
      expect(card.textContent).toContain('⚠')
      const toggle = byTestId(harness.container, 'v4-graph-lint-toggle')
      expect(toggle.textContent).toContain('个问题')
      click(toggle)
      const issues = byTestId(harness.container, 'v4-graph-issues')
      expect(issues.textContent).toContain('event')
      // 点击问题项定位节点（检查器切到该节点）
      click(issues.querySelector('.graph-issue'))
      expect(byTestId(harness.container, 'v4-graph-inspector').textContent).toContain('结算')
    } finally {
      harness.unmount()
    }
  })

  it('变量面板新增/改初值：走 updateFlow（tag=flow）', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      click(byTestId(harness.container, 'v4-graph-var-add'))
      expect(harness.tags()).toEqual(['flow'])
      const vars = harness.current().content.flow.vars ?? []
      expect(vars).toHaveLength(2)
      const added = vars[1]
      expect(added.key).toBe('var1')
      harness.rerender()
      const initInput = byTestId(harness.container, `v4-graph-var-init-var1`) as HTMLInputElement
      expect(initInput.value).toBe('0')
      typeInput(initInput, '5')
      blurInput(initInput)
      expect(harness.tags()).toEqual(['flow', 'flow'])
      expect((harness.current().content.flow.vars ?? [])[1]).toEqual({ key: 'var1', type: 'number', init: 5 })
    } finally {
      harness.unmount()
    }
  })

  it('主题切换：ge-dark ⇄ ge-light，写 localStorage graph-theme', () => {
    localStorage.clear()
    const harness = mountSlot('flow', sampleDoc())
    try {
      const root = byTestId(harness.container, 'v4-graph-workbench')
      expect(root.className).toContain('ge-dark')
      click(byTestId(harness.container, 'v4-graph-theme'))
      expect(byTestId(harness.container, 'v4-graph-workbench').className).toContain('ge-light')
      expect(localStorage.getItem('graph-theme')).toBe('light')
    } finally {
      harness.unmount()
    }
  })
})

describe('v4 GraphWorkbench · behavior 层', () => {
  it('surface 组件事件自动进入 on 候选；插入 handler 走 tag=behavior', () => {
    const harness = mountSlot('behavior', sampleDoc(), 'choice')
    try {
      const root = byTestId(harness.container, 'v4-graph-workbench')
      expect(root.getAttribute('data-layer')).toBe('behavior')
      expect(hasTestId(harness.container, 'graph-card-b_start')).toBe(true)
      expect(byTestId(harness.container, 'graph-card-b_start').textContent).toContain('事件')
      expect(byTestId(harness.container, 'graph-card-b_return').textContent).toContain('返回')
      // 事件入口候选：start + choice1.chosen（choice 契约事件）+ 自定义
      expect(hasTestId(harness.container, 'palette-item-on-start')).toBe(true)
      expect(hasTestId(harness.container, 'palette-item-on-choice1-chosen')).toBe(true)
      expect(hasTestId(harness.container, 'palette-item-on-custom')).toBe(true)
      click(byTestId(harness.container, 'palette-item-on-choice1-chosen'))
      expect(harness.tags()).toEqual(['behavior'])
      const behavior = harness.current().content.types.find((type) => type.id === 'choice')!.behavior
      expect(behavior.nodes).toHaveLength(3)
      const added = behavior.nodes.at(-1)!
      expect(added.kind).toBe('on')
      expect((added as { event: string }).event).toBe('choice1.chosen')
      // 其它题型的 behavior 未被触碰（updateBehavior 只换 choice 分支）
      expect(harness.current().content.types[0].behavior).toBe(behavior)
    } finally {
      harness.unmount()
    }
  })

  it('行为检查器：on 事件下拉切换 / return 返回值编辑（tag=behavior）', () => {
    const harness = mountSlot('behavior', sampleDoc(), 'choice')
    try {
      click(byTestId(harness.container, 'graph-card-b_start'))
      const select = byTestId(harness.container, 'v4-graph-field-on-event') as HTMLSelectElement
      expect(select.value).toBe('start')
      chooseSelect(select, 'choice1.chosen')
      expect(harness.tags()).toEqual(['behavior'])
      const behavior = harness.current().content.types.find((type) => type.id === 'choice')!.behavior
      expect((behavior.nodes.find((node) => node.id === 'b_start') as { event: string }).event).toBe('choice1.chosen')
      // return 节点：编辑返回值表达式
      harness.rerender()
      click(byTestId(harness.container, 'graph-card-b_return'))
      const resultInput = byTestId(harness.container, 'v4-graph-field-return') as HTMLTextAreaElement
      expect(resultInput.value).toContain('answered')
      typeTextarea(resultInput, "{ status: 'skipped' }")
      blurInput(resultInput)
      expect(harness.tags().at(-1)).toBe('behavior')
      const updated = harness.current().content.types.find((type) => type.id === 'choice')!.behavior
      expect((updated.nodes.find((node) => node.id === 'b_return') as { result: string }).result).toBe(
        "{ status: 'skipped' }",
      )
      // 行为变量面板展示题型状态作用域（只读）
      expect(byTestId(harness.container, 'v4-graph-vars-behavior-scope').textContent).toContain('q.state.')
    } finally {
      harness.unmount()
    }
  })
})

describe('v4 GraphWorkbench · 插槽契约（V4EditorShell 接线）', () => {
  it('renderFlow / renderBehavior 槽位分别渲染 flow 与 behavior 工作台', () => {
    let current = sampleDoc()
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const render = (): React.ReactElement => (
      <V4EditorShell
        doc={current}
        onChange={(next) => {
          current = next
        }}
        onSave={() => {}}
        dirty={false}
        revision={1}
        lintWarnings={[]}
        activeTab={undefined}
        renderFlow={(slotProps) => <FlowGraphSlot {...slotProps} />}
        renderBehavior={(slotProps) => <BehaviorGraphSlot {...slotProps} />}
      />
    )
    act(() => {
      root = createRoot(container)
      root.render(render())
    })
    try {
      // 流程 Tab → flow 工作台（data-layer=flow）
      click(byTestId(container, 'editor-tab-flow'))
      const flowRoot = byTestId(container, 'v4-graph-workbench')
      expect(flowRoot.getAttribute('data-layer')).toBe('flow')
      expect(hasTestId(container, 'graph-card-f_start')).toBe(true)
      // 题型 Tab → 选中题型 → 行为子页 → behavior 工作台
      click(byTestId(container, 'editor-tab-types'))
      click(byTestId(container, 'v4-types-item-choice'))
      click(byTestId(container, 'v4-type-subtab-behavior'))
      const behaviorRoot = byTestId(container, 'v4-graph-workbench')
      expect(behaviorRoot.getAttribute('data-layer')).toBe('behavior')
      expect(hasTestId(container, 'graph-card-b_start')).toBe(true)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})

describe('v4 GraphWorkbench · 伪代码视图（工作台内切换）', () => {
  it('flow：生成文本 → 编辑 → 应用回节点图（tag=flow，锚点保留 id）', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      click(byTestId(harness.container, 'v4-graph-view-script'))
      const textarea = byTestId(harness.container, 'v4-graph-script-text') as HTMLTextAreaElement
      expect(textarea.value).toContain('main {')
      expect(textarea.value).toContain('v.score = 0')
      const edited = textarea.value.replace('v.score >= 10', 'v.score >= 1')
      typeTextarea(textarea, edited)
      click(byTestId(harness.container, 'v4-graph-script-apply'))
      expect(harness.tags()).toEqual(['flow'])
      const flow = harness.current().content.flow
      const finish = flow.nodes.find((node) => node.kind === 'finish') as { id: string; passed?: string }
      expect(finish.passed).toBe('v.score >= 1')
      // 锚点合并：未改语句保留旧 id（f_init / f_start）
      expect(flow.nodes.some((node) => node.id === 'f_init')).toBe(true)
      expect(flow.nodes.some((node) => node.id === 'f_start')).toBe(true)
      expect(byTestId(harness.container, 'v4-graph-script-tip').textContent).toContain('已应用')
    } finally {
      harness.unmount()
    }
  })

  it('flow：语法错误就地提示且不修改文档', () => {
    const harness = mountSlot('flow', sampleDoc())
    try {
      click(byTestId(harness.container, 'v4-graph-view-script'))
      const textarea = byTestId(harness.container, 'v4-graph-script-text') as HTMLTextAreaElement
      typeTextarea(textarea, 'main {\n  这不是语句\n}')
      click(byTestId(harness.container, 'v4-graph-script-apply'))
      expect(harness.changes()).toHaveLength(0)
      const error = byTestId(harness.container, 'v4-graph-script-error')
      expect(error.textContent).toContain('解析失败')
      expect(error.textContent).toContain('第 2 行')
    } finally {
      harness.unmount()
    }
  })

  it('behavior：生成 on 事件块文本；编辑应用走 updateBehavior（tag=behavior）', () => {
    const harness = mountSlot('behavior', sampleDoc(), 'choice')
    try {
      click(byTestId(harness.container, 'v4-graph-view-script'))
      const textarea = byTestId(harness.container, 'v4-graph-script-text') as HTMLTextAreaElement
      expect(textarea.value).toContain('on start {')
      expect(textarea.value).toContain('return')
      const edited = textarea.value.replace("{ status: 'answered', correct: true }", "{ status: 'answered', correct: false }")
      typeTextarea(textarea, edited)
      click(byTestId(harness.container, 'v4-graph-script-apply'))
      expect(harness.tags()).toEqual(['behavior'])
      const behavior = harness.current().content.types.find((type) => type.id === 'choice')!.behavior
      const returned = behavior.nodes.find((node) => node.kind === 'return') as { id: string; result: string }
      // 改写语句不保留旧 id（锚点合并按语句特征配对）——结构仍是一个 on + 一个 return
      expect(returned.result).toContain('correct: false')
      expect(behavior.nodes.filter((node) => node.kind === 'return')).toHaveLength(1)
      expect(behavior.nodes.filter((node) => node.kind === 'on')).toHaveLength(1)
    } finally {
      harness.unmount()
    }
  })
})
