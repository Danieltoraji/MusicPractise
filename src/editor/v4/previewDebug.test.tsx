// @vitest-environment jsdom
/**
 * W7.2 / W7.3 预览调试与画布编辑测试（docs/52 §4 W7；docs/53 §13.3；W13 画布同源 docs/57）：
 *
 * ① ShellTab（画布）：视图新增/重命名/设初始/删除；共享画布新增/布局数字编辑/拖拽/
 *    绑定（槽位 + 实时表达式校验）/props JSON；全部经 onChange 且 tag='shell'，
 *    并且只替换 doc→content→shell 分支（结构共享：其它分支引用不变）。
 * ② PreviewTab（预览）：自建会话+调试控制器——开始后 LevelStageV4 舞台/题型帧挂载、
 *    调试面板（调用栈/作用域/牌堆/每题返回/日志/结算）、暂停/单步/继续生效；
 *    重开复位；文档引用变化重建会话；卸载时 controller.stop() → session.dispose()
 *    且不残留长定时器（docs/40 §12.4 运行归属）。consoleGate 全局兜底零噪音。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type { BehaviorProgram, FlowProgram, GraphEdge, LevelDocV4 } from '../../engine/v4/model'
import { V4Session } from '../../runtime/v4/session'
import { V4DebugController } from './debugRunV4'
import { PreviewTab } from './PreviewTab'
import { ShellTab } from './ShellTab'
import { V4EditorShell } from './V4EditorShell'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// 通用挂载 / 事件 / 等待工具
// ---------------------------------------------------------------------------

interface Mounted {
  container: HTMLElement
  rerender: (ui: React.ReactElement) => void
  unmount: () => void
}

const mountedComponents: { container: HTMLElement; root: Root; disposed: boolean }[] = []

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  const entry = { container, root, disposed: false }
  mountedComponents.push(entry)
  return {
    container,
    rerender: (next: React.ReactElement) => {
      act(() => root.render(next))
    },
    unmount: () => {
      if (entry.disposed) return
      entry.disposed = true
      act(() => root.unmount())
      container.remove()
    },
  }
}

afterEach(() => {
  for (const entry of mountedComponents.splice(0)) {
    if (!entry.disposed) {
      entry.disposed = true
      act(() => entry.root.unmount())
    }
    entry.container.remove()
  }
  vi.restoreAllMocks()
})

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`找不到锚点 ${testId}`)
  return el as HTMLElement
}

function maybeTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
}

function click(el: Element | null): void {
  if (!el) throw new Error('点击目标不存在')
  act(() => {
    ;(el as HTMLElement).click()
  })
}

const nativeInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
const nativeTextareaValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!

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

const flush = async (ms = 20): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await flush(10)
  }
}

/** 归一化空白后的文本（只用于既有文案契约断言；交互查询一律 data-testid） */
function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// 文档夹具
// ---------------------------------------------------------------------------

function edge(from: string, to: string, port?: 'true' | 'false'): GraphEdge {
  return { id: `e_${from}_${to}_${port ?? 'out'}`, from, to, ...(port ? { port } : {}) }
}

/** 点击选项才返回：surface 保持挂载直到用户作答 */
function clickToAnswer(): BehaviorProgram {
  return {
    logicVersion: 3,
    kind: 'behavior',
    nodes: [
      { id: 'b_start', kind: 'on', event: 'start' },
      { id: 'b_choice', kind: 'on', event: 'choice1.chosen' },
      { id: 'b_return', kind: 'return', result: "{ status: 'answered', correct: true, scoreDelta: q.scoring }" },
    ],
    edges: [edge('b_choice', 'b_return')],
  }
}

/** 顺序遍历题单 + 累加 scoreDelta + score>=20 通过 */
function askAllFlow(): FlowProgram {
  return {
    logicVersion: 3,
    kind: 'flow',
    nodes: [
      { id: 'f_start', kind: 'start' },
      { id: 'f_foreach', kind: 'foreach', items: 'run.questions', itemVar: 'slot' },
      { id: 'f_ask', kind: 'ask', target: 'local.slot', resultVar: 'result' },
      { id: 'f_apply', kind: 'assign', target: 'v.score', value: { expr: 'v.score + local.result.scoreDelta' } },
      { id: 'f_finish', kind: 'finish', passed: 'v.score >= 20' },
    ],
    edges: [
      edge('f_start', 'f_foreach'),
      edge('f_foreach', 'f_ask', 'true'),
      edge('f_foreach', 'f_finish', 'false'),
      edge('f_ask', 'f_apply'),
      edge('f_apply', 'f_foreach'),
    ],
    vars: [{ key: 'score', type: 'number', init: 0 }],
  }
}

/** 可交互最小关：2 题，点击选项作答 */
function playableDoc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.types[0].behavior = clickToAnswer()
  doc.content.flow = askAllFlow()
  return doc
}

/** start → 长 wait（用于验证卸载清理长定时器）；vars 必须声明 shell 绑定用到的 v.score */
function waitDoc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.flow = {
    logicVersion: 3,
    kind: 'flow',
    nodes: [
      { id: 'f_start', kind: 'start' },
      { id: 'f_wait', kind: 'wait', ms: '5000' },
      { id: 'f_finish', kind: 'finish' },
    ],
    edges: [edge('f_start', 'f_wait'), edge('f_wait', 'f_finish')],
    vars: [{ key: 'score', type: 'number', init: 0 }],
  }
  return doc
}

// ---------------------------------------------------------------------------
// ShellTab · 画布编辑
// ---------------------------------------------------------------------------

interface ShellHarness {
  mounted: Mounted
  current: () => LevelDocV4
  changes: () => LevelDocV4[]
  tags: () => (string | undefined)[]
  sync: () => void
}

function mountShell(initial: LevelDocV4): ShellHarness {
  let current = initial
  const changes: LevelDocV4[] = []
  const tags: (string | undefined)[] = []
  const render = (): React.ReactElement => (
    <ShellTab
      doc={current}
      revision={changes.length}
      onChange={(next, tag) => {
        changes.push(next)
        tags.push(tag)
        current = next
      }}
    />
  )
  const mounted = mount(render())
  return {
    mounted,
    current: () => current,
    changes: () => changes,
    tags: () => tags,
    sync: () => mounted.rerender(render()),
  }
}

describe('ShellTab（画布：视图 / 组件画布 / 属性 / 绑定）', () => {
  it('视图管理：新增/重命名/设初始/删除，全部 tag=shell 且不触碰其它分支引用', () => {
    const initial = minimalLevelDoc()
    const harness = mountShell(initial)
    const { container } = harness.mounted
    try {
      const shell = harness.current().content.shell
      expect(byTestId(container, 'v4-shell-tab')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas').getAttribute('data-layer')).toBe('shell')
      expect(byTestId(container, 'v4-canvas-palette')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas-views')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas-stage')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas-box-scoreLabel')).toBeTruthy()
      expect(byTestId(container, `v4-canvas-view-initial-${shell.views[0].id}`).hasAttribute('disabled')).toBe(true)

      // 新增视图：views+1，切到新视图（空视图提示）
      click(byTestId(container, 'v4-canvas-view-add'))
      harness.sync()
      const afterAddView = harness.current()
      expect(afterAddView.content.shell.views).toHaveLength(2)
      expect(harness.tags().at(-1)).toBe('shell')
      expect(afterAddView.content.types).toBe(initial.content.types)
      expect(afterAddView.content.tables).toBe(initial.content.tables)
      expect(afterAddView.content.flow).toBe(initial.content.flow)
      expect(afterAddView.meta).toBe(initial.meta)
      const newViewId = afterAddView.content.shell.views[1].id
      expect(byTestId(container, `v4-canvas-view-${newViewId}`)).toBeTruthy()
      expect(byTestId(container, 'v4-canvas-empty')).toBeTruthy()

      // 重命名（逐键 tag=shell）
      typeInput(byTestId(container, `v4-canvas-view-name-${newViewId}`) as HTMLInputElement, '第二视图')
      harness.sync()
      expect(harness.current().content.shell.views[1].name).toBe('第二视图')
      expect(harness.tags().at(-1)).toBe('shell')

      // 设为初始视图
      click(byTestId(container, `v4-canvas-view-initial-${newViewId}`))
      harness.sync()
      expect(harness.current().content.shell.initialView).toBe(newViewId)
      expect(byTestId(container, `v4-canvas-view-initial-${newViewId}`).hasAttribute('disabled')).toBe(true)

      // 删除视图（级联清 initialView，回落到首视图）
      click(byTestId(container, `v4-canvas-view-remove-${newViewId}`))
      harness.sync()
      const afterRemove = harness.current()
      expect(afterRemove.content.shell.views).toHaveLength(1)
      expect(afterRemove.content.shell.initialView).toBeUndefined()
      expect(harness.tags().at(-1)).toBe('shell')
      expect(byTestId(container, 'v4-canvas-box-scoreLabel')).toBeTruthy()
      // 文档纯度：初始文档未被原地修改
      expect(initial.content.shell.views).toHaveLength(1)
      expect(initial.content.shell.components).toHaveLength(1)
    } finally {
      harness.mounted.unmount()
    }
  })

  it('组件新增/布局/绑定/props/拖拽/删除：tag=shell，结构共享只换 shell 分支', () => {
    const initial = minimalLevelDoc()
    const harness = mountShell(initial)
    const { container } = harness.mounted
    try {
      const beforeAdd = harness.current()

      // 组件面板列表 → 一键新增（归入当前视图，默认格位在画布内）
      click(byTestId(container, 'v4-canvas-add-label'))
      harness.sync()
      const afterAdd = harness.current()
      expect(afterAdd.content.shell.components).toHaveLength(2)
      expect(harness.tags().at(-1)).toBe('shell')
      // 结构共享：只复制 doc→content→shell；其它分支引用不变
      expect(afterAdd.content.types).toBe(beforeAdd.content.types)
      expect(afterAdd.content.tables).toBe(beforeAdd.content.tables)
      expect(afterAdd.content.flow).toBe(beforeAdd.content.flow)
      expect(afterAdd.meta).toBe(beforeAdd.meta)
      expect(afterAdd.content.shell).not.toBe(beforeAdd.content.shell)
      const added = afterAdd.content.shell.components[1]
      expect(added.type).toBe('label')
      expect(added.view).toBe('main')
      expect(added.layout?.y).toBeLessThan(470)
      // 新组件自动选中 → 属性检查器出现
      expect(byTestId(container, 'v4-canvas-inspector')).toBeTruthy()
      expect(byTestId(container, `v4-canvas-box-${added.id}`).getAttribute('data-selected')).toBe('true')

      // 数字布局：x 精确编辑（tag=shell；其它分支仍共享）
      typeInput(byTestId(container, 'v4-canvas-layout-x') as HTMLInputElement, '300')
      harness.sync()
      const afterLayout = harness.current()
      const laidOut = afterLayout.content.shell.components[1]
      expect(laidOut.layout?.x).toBe(300)
      expect(harness.tags().at(-1)).toBe('shell')
      expect(afterLayout.content.types).toBe(beforeAdd.content.types)
      expect(afterLayout.content.flow).toBe(beforeAdd.content.flow)

      // 绑定：新增槽位 → 输入只读表达式 → 写入 bindings（根校验通过）
      click(byTestId(container, 'v4-canvas-binding-add'))
      typeInput(byTestId(container, 'v4-canvas-binding-expr-text') as HTMLInputElement, 'v.score + 1')
      harness.sync()
      const afterBinding = harness.current()
      expect(afterBinding.content.shell.components[1].bindings?.text).toBe('v.score + 1')
      expect(harness.tags().at(-1)).toBe('shell')
      expect(afterBinding.content.flow).toBe(beforeAdd.content.flow)

      // 实时校验：非法表达式显示错误（不静默吞掉）
      typeInput(byTestId(container, 'v4-canvas-binding-expr-text') as HTMLInputElement, 'v.')
      harness.sync()
      const errorEl = byTestId(container, 'v4-canvas-binding-error-text')
      expect(text(errorEl).length).toBeGreaterThan(0)
      // 修正后错误消失
      typeInput(byTestId(container, 'v4-canvas-binding-expr-text') as HTMLInputElement, 'v.score')
      harness.sync()
      expect(maybeTestId(container, 'v4-canvas-binding-error-text')).toBeNull()

      // props JSON 编辑弹窗
      click(byTestId(container, 'v4-canvas-props-edit'))
      typeTextarea(byTestId(container, 'v4-canvas-props-text') as HTMLTextAreaElement, '{"text":"画布标签"}')
      click(byTestId(container, 'v4-canvas-props-apply'))
      harness.sync()
      expect(harness.current().content.shell.components[1].props).toEqual({ text: '画布标签' })
      expect(harness.tags().at(-1)).toBe('shell')

      // 拖拽平移：pointerdown→move→up 落点一次 commit，只有一个新文档（撤销合并前提）
      const beforeDrag = harness.current()
      const beforeDragCount = harness.changes().length
      const layoutBefore = beforeDrag.content.shell.components[1].layout!
      const box = byTestId(container, `v4-canvas-box-${added.id}`)
      act(() => {
        box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, clientX: 100, clientY: 100 }))
        box.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 5, clientX: 160, clientY: 130 }))
        box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5 }))
      })
      harness.sync()
      const afterDrag = harness.current()
      expect(harness.changes().length).toBe(beforeDragCount + 1)
      expect(harness.tags().at(-1)).toBe('shell')
      expect(afterDrag.content.shell.components[1].layout?.x).not.toBe(layoutBefore.x)
      expect(afterDrag.content.shell.components[1].layout?.y).not.toBe(layoutBefore.y)
      expect(afterDrag.content.flow).toBe(beforeDrag.content.flow)

      // 删除组件
      const afterDragCount = harness.changes().length
      click(byTestId(container, 'v4-canvas-remove'))
      harness.sync()
      expect(harness.current().content.shell.components).toHaveLength(1)
      expect(harness.changes().length).toBe(afterDragCount + 1)
      expect(harness.tags().at(-1)).toBe('shell')
      expect(maybeTestId(container, 'v4-canvas-inspector')).toBeNull()
      // 全流程 tag 恒为 shell（撤销栈按 shell 连续合并）
      expect(new Set(harness.tags())).toEqual(new Set(['shell']))
    } finally {
      harness.mounted.unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// PreviewTab · 可见游玩 + 调试面板
// ---------------------------------------------------------------------------

function mountPreview(doc: LevelDocV4): Mounted {
  return mount(<PreviewTab doc={doc} revision={0} onChange={() => undefined} />)
}

describe('PreviewTab（v4 游玩画面 + 调试控制）', () => {
  it('未开始时只渲染 shell 舞台；开始后题型帧挂载、进度/牌堆/作用域/每题返回/结算可用', async () => {
    const doc = playableDoc()
    const mounted = mountPreview(doc)
    const { container } = mounted
    try {
      // 空闲态：会话已创建（stage 常驻 shell），但流程未跑/未发牌、无题型帧
      await waitFor(() => maybeTestId(container, 'v4-stage-viewport') !== null, '舞台挂载')
      expect(byTestId(container, 'v4-preview-tab')).toBeTruthy()
      expect(maybeTestId(container, 'v4-surface')).toBeNull()
      expect(byTestId(container, 'v4-preview-start').hasAttribute('disabled')).toBe(false)
      expect(byTestId(container, 'v4-preview-stop').hasAttribute('disabled')).toBe(true)
      expect(text(byTestId(container, 'v4-preview-progress'))).toContain('0 / 0')
      expect(byTestId(container, 'v4-preview-run-state').getAttribute('data-phase')).toBe('idle')

      // 开始：第一题 ask 帧挂载
      click(byTestId(container, 'v4-preview-start'))
      await waitFor(() => maybeTestId(container, 'v4-surface') !== null, '第一帧 surface 挂载')
      await waitFor(() => text(byTestId(container, 'v4-preview-progress')).includes('1 / 2'), '进度 1/2')
      expect(byTestId(container, 'v4-shell')).toBeTruthy()
      expect(byTestId(container, 'v4-preview-run-state').getAttribute('data-phase')).toBe('live')
      expect(container.querySelectorAll('[data-testid^="v4-preview-deck-item-"]')).toHaveLength(2)
      // 作用域：q 为当前题型内容、q.state 已初始化、run.total 来自牌堆
      expect(text(byTestId(container, 'v4-preview-scope-q'))).toContain('听一听')
      expect(text(byTestId(container, 'v4-preview-scope-qstate'))).toContain('answered')
      expect(text(byTestId(container, 'v4-preview-scope-run'))).toContain('"total":2')
      // 调用栈：flow + behavior 两帧
      await waitFor(() => maybeTestId(container, 'v4-preview-frame-1') !== null, '调用栈两帧')
      expect(text(byTestId(container, 'v4-preview-frame-0'))).toContain('flow')
      expect(text(byTestId(container, 'v4-preview-frame-1'))).toContain('choice')

      // 作答第一题：每题返回列表与第二帧
      await act(async () => {
        ;(container.querySelector('[data-testid="v4-surface"] .choice-item') as HTMLElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        )
      })
      await waitFor(() => maybeTestId(container, 'v4-preview-question-1') !== null, '每题返回 #1')
      expect(text(byTestId(container, 'v4-preview-question-1'))).toContain('choice/row_01')
      await waitFor(() => text(byTestId(container, 'v4-preview-progress')).includes('2 / 2'), '进度 2/2')

      // 作答第二题：结算（pass + 分数），每题返回两条
      await act(async () => {
        ;(container.querySelector('[data-testid="v4-surface"] .choice-item') as HTMLElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        )
      })
      await waitFor(() => maybeTestId(container, 'v4-preview-result') !== null, '结算出现')
      const result = byTestId(container, 'v4-preview-result')
      expect(result.getAttribute('data-passed')).toBe('true')
      expect(text(result)).toContain('得分 20')
      expect(byTestId(container, 'v4-preview-question-2')).toBeTruthy()
      expect(container.querySelectorAll('[data-testid^="v4-preview-log-"]').length).toBeGreaterThan(0)

      // 重开：结算消失、回到第一题
      click(byTestId(container, 'v4-preview-replay'))
      await waitFor(() => maybeTestId(container, 'v4-preview-result') === null, '重开清除结算')
      await waitFor(() => text(byTestId(container, 'v4-preview-progress')).includes('1 / 2'), '重开回到 1/2')
      expect(maybeTestId(container, 'v4-surface')).not.toBeNull()
      expect(maybeTestId(container, 'v4-preview-question-1')).toBeNull()
    } finally {
      mounted.unmount()
    }
  })

  it('单步/继续/暂停：按节点边界暂停，继续跑到结算', async () => {
    const mounted = mountPreview(minimalLevelDoc())
    const { container } = mounted
    try {
      await waitFor(() => maybeTestId(container, 'v4-stage-viewport') !== null, '舞台挂载')

      // 单步（未开始时设置 pauseNext）→ 开始 → 在首个节点边界暂停
      click(byTestId(container, 'v4-preview-step'))
      click(byTestId(container, 'v4-preview-start'))
      await waitFor(() => maybeTestId(container, 'v4-preview-paused') !== null, '首节点暂停')
      const paused = byTestId(container, 'v4-preview-paused')
      expect(paused.getAttribute('data-kind')).toBe('flow')
      expect(paused.getAttribute('data-node')).toBe('f_start')
      expect(text(byTestId(container, 'v4-preview-run-state'))).toContain('已暂停')
      expect(byTestId(container, 'v4-preview-pause').hasAttribute('disabled')).toBe(true)

      // 单步 → 执行当前节点后在下一节点再次暂停
      click(byTestId(container, 'v4-preview-step'))
      await waitFor(
        () => maybeTestId(container, 'v4-preview-paused')?.getAttribute('data-node') === 'f_init',
        '第二步暂停于 f_init',
      )
      // 继续 → 跑到结算（v.score 0 < 10 → 未通过）
      click(byTestId(container, 'v4-preview-resume'))
      await waitFor(() => maybeTestId(container, 'v4-preview-result') !== null, '结算')
      expect(byTestId(container, 'v4-preview-result').getAttribute('data-passed')).toBe('false')
      expect(text(byTestId(container, 'v4-preview-scope-v'))).toContain('"score":0')
      expect(maybeTestId(container, 'v4-preview-paused')).toBeNull()

      // 计时器暂停开关（session.setTimersPaused 透传，无计时器时也不报错）
      const timerToggle = byTestId(container, 'v4-preview-timers-pause') as HTMLInputElement
      click(timerToggle)
      expect(timerToggle.checked).toBe(true)
    } finally {
      mounted.unmount()
    }
  })

  it('暂停按钮：运行前点暂停 → 首个节点边界暂停，继续后结算', async () => {
    const mounted = mountPreview(minimalLevelDoc())
    const { container } = mounted
    try {
      await waitFor(() => maybeTestId(container, 'v4-stage-viewport') !== null, '舞台挂载')
      click(byTestId(container, 'v4-preview-pause'))
      click(byTestId(container, 'v4-preview-start'))
      await waitFor(() => maybeTestId(container, 'v4-preview-paused') !== null, '暂停于首节点')
      click(byTestId(container, 'v4-preview-resume'))
      await waitFor(() => maybeTestId(container, 'v4-preview-result') !== null, '结算')
    } finally {
      mounted.unmount()
    }
  })

  it('文档引用变化重建会话；卸载时 controller.stop() → session.dispose() 且不残留长定时器', async () => {
    // 追踪长定时器（wait 5000ms）：卸载后必须被清理（无会话/计时器泄漏）
    const longHandles = new Set<unknown>()
    const originalSetTimeout = globalThis.setTimeout as (
      handler: () => void,
      timeout?: number,
      ...args: unknown[]
    ) => unknown
    const originalClearTimeout = globalThis.clearTimeout as (handle?: unknown) => void
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: () => void,
      timeout?: number,
      ...args: unknown[]
    ) => {
      const handle = originalSetTimeout(handler, timeout, ...args)
      if ((timeout ?? 0) >= 4000) longHandles.add(handle)
      return handle
    }) as unknown as typeof globalThis.setTimeout)
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle?: unknown) => {
      longHandles.delete(handle)
      originalClearTimeout(handle)
    }) as unknown as typeof globalThis.clearTimeout)

    const disposeSpy = vi.spyOn(V4Session.prototype, 'dispose')
    const stopSpy = vi.spyOn(V4DebugController.prototype, 'stop')

    const first = waitDoc()
    const mounted = mountPreview(first)
    const { container } = mounted
    try {
      click(byTestId(container, 'v4-preview-start'))
      await waitFor(() => longHandles.size === 1, '流程进入 wait（长定时器已排程）')

      // 文档引用变化 → 旧会话 stop/dispose 并重建新会话（原运行态保留为自动开始）
      const second = waitDoc()
      second.meta = { ...second.meta, title: '重载后的文档' }
      mounted.rerender(<PreviewTab doc={second} revision={1} onChange={() => undefined} />)
      await waitFor(() => disposeSpy.mock.calls.length >= 1, '旧会话 dispose')
      await waitFor(() => longHandles.size === 1, '新会话 wait 长定时器就绪')
      expect(stopSpy.mock.calls.length).toBeGreaterThanOrEqual(1)

      mounted.unmount()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
      })
      expect(disposeSpy.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(longHandles.size, '卸载后仍残留长定时器（会话未清理）').toBe(0)
    } finally {
      mounted.unmount()
    }
  })
})

// ---------------------------------------------------------------------------
// 插槽接入（Lead 在路由层按下列方式接线；此处直接验证契约可用）
// ---------------------------------------------------------------------------

describe('W7 插槽接入（V4EditorShell · renderShell/renderPreview）', () => {
  it('舞台/预览槽位可挂载；预览运行中切走 Tab 即卸载并停止会话', async () => {
    const doc = playableDoc()
    const mounted = mount(
      <V4EditorShell
        doc={doc}
        onChange={() => undefined}
        onSave={() => undefined}
        dirty={false}
        revision={0}
        lintWarnings={[]}
        renderShell={(props) => <ShellTab {...props} />}
        renderPreview={(props) => <PreviewTab {...props} />}
      />,
    )
    const { container } = mounted
    try {
      click(byTestId(container, 'editor-tab-shell'))
      expect(byTestId(container, 'v4-shell-tab')).toBeTruthy()

      click(byTestId(container, 'editor-tab-preview'))
      expect(byTestId(container, 'v4-preview-tab')).toBeTruthy()
      await waitFor(() => maybeTestId(container, 'v4-stage-viewport') !== null, '预览舞台挂载')
      click(byTestId(container, 'v4-preview-start'))
      await waitFor(() => maybeTestId(container, 'v4-surface') !== null, '题型帧挂载')

      // 切走预览 Tab（等价于编辑器卸载该槽位）→ 会话必须 stop/dispose（docs/40 §12.4）
      const disposeSpy = vi.spyOn(V4Session.prototype, 'dispose')
      click(byTestId(container, 'editor-tab-content'))
      await waitFor(() => disposeSpy.mock.calls.length >= 1, '切走预览 Tab → 会话 dispose')
      expect(maybeTestId(container, 'v4-preview-tab')).toBeNull()
      expect(byTestId(container, 'v4-content-tab')).toBeTruthy()
    } finally {
      mounted.unmount()
    }
  })
})
