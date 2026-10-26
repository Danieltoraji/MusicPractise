// @vitest-environment jsdom
/**
 * 预设画廊 UI 测试（docs/52 §4 W8.1；docs/53 §14）：jsdom。
 *
 * 覆盖：分层列表渲染 / 选中切换说明 / 参数表单（文本·数字·下拉）变化进入展开产物 /
 * 插入回调收到合法 nodes+edges（id 唯一、端点闭合、entryId 存在、带落点坐标）/
 * 表达式参数实时报错并禁用插入 / behavior 缺 typeId 的提示 / 插入后 lint 预览与
 * flow 变量声明缺失提示（画廊不改文档）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadLevelDocV4 } from '../../../library/validate'
import { createLevelFromTemplate } from '../../../engine/v4/templates'
import type { BehaviorNode, FlowNode, LevelDocV4 } from '../../../engine/v4/model'
import { cloneLevelDocV4 } from '../../../engine/v4/model'
import { PresetGallery, type PresetInsertResult } from './PresetGallery'

const reactive = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
reactive.IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// 挂载/查询/交互助手（与 v4 编辑器既有 jsdom 测试同口径）
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
  const element = container.querySelector(`[data-testid="${testId}"]`)
  if (!element) throw new Error(`找不到锚点 ${testId}`)
  return element as HTMLElement
}

function maybeTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
}

function click(element: Element | null): void {
  if (!element) throw new Error('点击目标不存在')
  act(() => {
    ;(element as HTMLElement).click()
  })
}

const nativeInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
const nativeSelectValue = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!

/** 受控 input：native setter + input 事件（React value tracker 放行） */
function typeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    nativeInputValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function chooseSelect(select: HTMLSelectElement, value: string): void {
  act(() => {
    nativeSelectValue.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function textOf(element: Element | null): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function loaded<T extends LevelDocV4>(doc: T): LevelDocV4 {
  const result = loadLevelDocV4(doc)
  if (!result.ok) throw new Error(`夹具装载失败：${result.errors.join(' / ')}`)
  return result.doc
}

function flowDoc(): LevelDocV4 {
  return loaded(createLevelFromTemplate('listen-choice'))
}

function behaviorDoc(typeId = 'choice-listen'): LevelDocV4 {
  const doc = loaded(createLevelFromTemplate('tutorial'))
  if (!doc.content.types.some((type) => type.id === typeId)) throw new Error(`夹具缺少题型 ${typeId}`)
  return doc
}

/** 插入结果结构断言：id 唯一、边端点闭合、entryId 存在、节点都带落点坐标 */
function expectInsertResult(result: PresetInsertResult): void {
  expect(result.nodes.length).toBeGreaterThan(0)
  expect(result.edges.length).toBeGreaterThan(0)
  const nodeIds = new Set<string>()
  for (const node of result.nodes) {
    expect(nodeIds.has(node.id), `节点 id 重复：${node.id}`).toBe(false)
    nodeIds.add(node.id)
    expect(typeof (node as { x?: unknown }).x).toBe('number')
    expect(typeof (node as { y?: unknown }).y).toBe('number')
  }
  const edgeIds = new Set<string>()
  for (const edge of result.edges) {
    expect(edgeIds.has(edge.id), `连线 id 重复：${edge.id}`).toBe(false)
    edgeIds.add(edge.id)
    expect(nodeIds.has(edge.from), `连线端点悬空：${edge.from}`).toBe(true)
    expect(nodeIds.has(edge.to), `连线端点悬空：${edge.to}`).toBe(true)
  }
  expect(result.entryId).toBeTruthy()
  expect(nodeIds.has(result.entryId as string)).toBe(true)
}

function findNode<T extends FlowNode | BehaviorNode = FlowNode>(nodes: (FlowNode | BehaviorNode)[], predicate: (node: FlowNode | BehaviorNode) => boolean): T {
  const found = nodes.find(predicate)
  if (!found) throw new Error('未找到预期节点')
  return found as T
}

function findByTarget(nodes: (FlowNode | BehaviorNode)[], target: string): FlowNode | undefined {
  return nodes.find((node) => node.kind === 'assign' && (node as { target?: string }).target === target) as FlowNode | undefined
}

// ---------------------------------------------------------------------------
// flow 层
// ---------------------------------------------------------------------------

describe('PresetGallery · flow 层', () => {
  it('渲染流程预设列表 + 默认选中项的说明与表单；切换列表项更新说明', () => {
    const doc = flowDoc()
    const onInsert = vi.fn()
    const { container } = mount(<PresetGallery doc={doc} layer="flow" onInsert={onInsert} />)

    expect(byTestId(container, 'v4-preset-gallery').getAttribute('data-layer')).toBe('flow')
    expect(container.querySelectorAll('[data-testid^="v4-preset-item-"]')).toHaveLength(4)
    expect(maybeTestId(container, 'v4-preset-item-sequence-grade-settle')).toBeTruthy()
    expect(maybeTestId(container, 'v4-preset-item-retry-n')).toBeTruthy()
    expect(maybeTestId(container, 'v4-preset-item-unlock-branch')).toBeTruthy()
    expect(maybeTestId(container, 'v4-preset-item-settle-then-replay')).toBeTruthy()
    expect(textOf(byTestId(container, 'v4-preset-title'))).toBe('顺序出题 · 计分结算')
    expect(textOf(byTestId(container, 'v4-preset-description'))).toContain('foreach')
    expect(maybeTestId(container, 'v4-preset-param-passExpr')).toBeTruthy()
    expect(maybeTestId(container, 'v4-preset-param-updateRow')?.tagName).toBe('SELECT')

    click(byTestId(container, 'v4-preset-item-retry-n'))
    expect(textOf(byTestId(container, 'v4-preset-title'))).toBe('答错重试 N 次')
    expect(maybeTestId(container, 'v4-preset-param-retries')?.tagName).toBe('INPUT')
    expect(maybeTestId(container, 'v4-preset-param-askTarget')).toBeTruthy()
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('参数变化进入产物（表达式/数字/下拉），插入回调收到合法 nodes+edges+entryId', () => {
    const doc = flowDoc()
    const flowBefore = JSON.stringify(doc.content.flow)
    const insertions: PresetInsertResult[] = []
    const { container } = mount(
      <PresetGallery doc={doc} layer="flow" onInsert={(result) => insertions.push(result)} />,
    )

    typeInput(byTestId(container, 'v4-preset-param-passExpr') as HTMLInputElement, 'v.score >= 5')
    chooseSelect(byTestId(container, 'v4-preset-param-updateRow') as HTMLSelectElement, 'no')
    click(byTestId(container, 'v4-preset-insert'))

    expect(insertions).toHaveLength(1)
    const result = insertions[0]
    expectInsertResult(result)
    expect(result.presetId).toBe('sequence-grade-settle')
    const finish = findNode(result.nodes, (node) => node.kind === 'finish') as { passed?: string }
    expect(finish.passed).toBe('v.score >= 5')
    // updateRow=no → 不生成 v.row 赋值节点
    expect(findByTarget(result.nodes, 'v.row')).toBeUndefined()
    expect(textOf(maybeTestId(container, 'v4-preset-status'))).toContain('已插入')
    // 插入不写文档（画廊只读：onInsert 只把节点组交给宿主）
    expect(JSON.stringify(doc.content.flow)).toBe(flowBefore)
  })

  it('数字参数钳制 + 下拉参数生效（retry-n：retries=2 → 3 个 ask 节点）', () => {
    const doc = flowDoc()
    const insertions: PresetInsertResult[] = []
    const { container } = mount(
      <PresetGallery doc={doc} layer="flow" onInsert={(result) => insertions.push(result)} />,
    )
    click(byTestId(container, 'v4-preset-item-retry-n'))
    typeInput(byTestId(container, 'v4-preset-param-retries') as HTMLInputElement, '2')
    click(byTestId(container, 'v4-preset-insert'))
    expect(insertions).toHaveLength(1)
    expectInsertResult(insertions[0])
    const asks = insertions[0].nodes.filter((node) => node.kind === 'ask')
    expect(asks).toHaveLength(3)
    const branches = insertions[0].nodes.filter((node) => node.kind === 'branch')
    expect(branches).toHaveLength(2)
  })

  it('表达式参数非法时显示错误并禁用插入；合法后恢复可插入', () => {
    const doc = flowDoc()
    const { container } = mount(<PresetGallery doc={doc} layer="flow" onInsert={() => {}} />)
    click(byTestId(container, 'v4-preset-item-unlock-branch'))
    const insertButton = byTestId(container, 'v4-preset-insert') as HTMLButtonElement
    expect(insertButton.disabled).toBe(false)
    typeInput(byTestId(container, 'v4-preset-param-unlockCond') as HTMLInputElement, 'v.score >=')
    expect(maybeTestId(container, 'v4-preset-param-unlockCond-error')).toBeTruthy()
    expect(insertButton.disabled).toBe(true)
    typeInput(byTestId(container, 'v4-preset-param-unlockCond') as HTMLInputElement, 'v.score >= 3')
    expect(maybeTestId(container, 'v4-preset-param-unlockCond-error')).toBeNull()
    expect(insertButton.disabled).toBe(false)
  })

  it('插入后结构校验预览：waitShell 引用不存在的 shell 组件会显示错误（不只语义 lint）', () => {
    const doc = flowDoc() // listen-choice 模板的 shell 没有 replayBtn
    const { container } = mount(<PresetGallery doc={doc} layer="flow" onInsert={() => {}} />)
    click(byTestId(container, 'v4-preset-item-settle-then-replay'))
    const preview = textOf(byTestId(container, 'v4-preset-preview'))
    expect(preview).toContain('个错误')
    expect(preview).toContain('replayBtn')
  })

  it('插入后 lint 预览列出缺失的 run 变量声明（画廊不改 doc，只提示；插入结果带 declarations）', () => {
    const doc = cloneLevelDocV4(flowDoc())
    // 移除 row 声明：sequence 预设会写 v.row → 预览应报「未声明的 run 变量」
    doc.content.flow.vars = (doc.content.flow.vars ?? []).filter((field) => field.key !== 'row')
    const insertions: PresetInsertResult[] = []
    const { container } = mount(
      <PresetGallery doc={doc} layer="flow" onInsert={(result) => insertions.push(result)} />,
    )
    const declarations = byTestId(container, 'v4-preset-declarations')
    expect(textOf(declarations)).toContain('v.row')
    const preview = byTestId(container, 'v4-preset-preview')
    expect(textOf(preview)).toContain('个错误')
    expect(textOf(preview)).toContain('v.row')
    // 文档本身未被修改
    expect((doc.content.flow.vars ?? []).some((field) => field.key === 'row')).toBe(false)
    // 宿主可用插入结果的 declarations 一次 update 补齐声明
    click(byTestId(container, 'v4-preset-insert'))
    expect(insertions).toHaveLength(1)
    expect(insertions[0].declarations?.map((field) => field.key)).toEqual(['row'])
  })
})

// ---------------------------------------------------------------------------
// behavior 层
// ---------------------------------------------------------------------------

describe('PresetGallery · behavior 层', () => {
  it('渲染 7 个行为预设；插入 first-correct-once 收到 on 入口 + return 的普通节点组', () => {
    const doc = behaviorDoc()
    const insertions: PresetInsertResult[] = []
    const { container } = mount(
      <PresetGallery doc={doc} layer="behavior" typeId="choice-listen" onInsert={(result) => insertions.push(result)} />,
    )
    expect(byTestId(container, 'v4-preset-gallery').getAttribute('data-layer')).toBe('behavior')
    expect(container.querySelectorAll('[data-testid^="v4-preset-item-"]')).toHaveLength(7)
    expect(maybeTestId(container, 'v4-preset-item-first-correct-once')).toBeTruthy()
    expect(maybeTestId(container, 'v4-preset-item-feedback-hint')).toBeTruthy()
    expect(textOf(byTestId(container, 'v4-preset-title'))).toBe('首次答对只计一次')
    // 图内已有 on start（题型原有行为）不应被计数为预设项
    click(byTestId(container, 'v4-preset-insert'))
    expect(insertions).toHaveLength(1)
    const result = insertions[0]
    expectInsertResult(result)
    const entry = findNode(result.nodes, (node) => node.id === result.entryId)
    expect(entry.kind).toBe('on')
    expect((entry as { event?: string }).event).toBe('choice1.chosen')
    expect(result.nodes.some((node) => node.kind === 'return')).toBe(true)
    expect(doc.content.types.find((type) => type.id === 'choice-listen')?.behavior.nodes.some((node) => node.id.startsWith('ps_'))).toBe(false)
  })

  it('缺 typeId 时显示提示且禁用插入；选择事件参数生效', () => {
    const doc = behaviorDoc()
    const insertions: PresetInsertResult[] = []
    const { container, rerender } = mount(
      <PresetGallery doc={doc} layer="behavior" onInsert={(result) => insertions.push(result)} />,
    )
    expect(maybeTestId(container, 'v4-preset-missing-type')).toBeTruthy()
    expect((byTestId(container, 'v4-preset-insert') as HTMLButtonElement).disabled).toBe(true)

    rerender(<PresetGallery doc={doc} layer="behavior" typeId="choice-listen" onInsert={(result) => insertions.push(result)} />)
    click(byTestId(container, 'v4-preset-item-manual-next'))
    typeInput(byTestId(container, 'v4-preset-param-event') as HTMLInputElement, 'nextBtn.clicked')
    click(byTestId(container, 'v4-preset-insert'))
    expect(insertions).toHaveLength(1)
    const on = findNode(insertions[0].nodes, (node) => node.kind === 'on') as { event?: string }
    expect(on.event).toBe('nextBtn.clicked')
  })
})
