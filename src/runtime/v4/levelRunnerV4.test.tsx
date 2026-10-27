// @vitest-environment jsdom
/**
 * v4 播放层 jsdom 用例（docs/52 W3 / docs/53 §11 / docs/54 Round 7）：
 * - LevelRunnerV4：shell 常驻、ask 帧 surface 挂载/返回后卸载、进度、结算条、重玩复位；
 * - LevelStageV4：无题型调用时不渲染 surface 层、shell 视图过滤与 shell 事件路由；
 * - 绑定（W3.4 spike S1）：choice.options 挂载初值渲染（初值命令补发回归）、
 *   求值失败降级为静态 props + 单次运行日志、不中断关卡、不写 console。
 * 控制台零噪音由全局 consoleGate（src/test/setup.ts）兜底：本文件不产生 console.error/warn。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type {
  BehaviorProgram,
  FlowProgram,
  GraphEdge,
  LevelDocV4,
  RunResult,
} from '../../engine/v4/model'
import { LevelRunnerV4 } from './LevelRunnerV4'
import { LevelStageV4 } from './LevelStageV4'
import { V4Session, type V4RunEvent } from './session'
import { SILENT_EFFECTS, createV4SessionHost, useV4Snapshot } from './sessionHost'

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

afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  containers.splice(0).forEach((container) => container.remove())
})

const flush = async (ms = 20): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`)
    await flush(10)
  }
}

/** 归一化空白后的文本（既有文案契约断言用；新交互一律用 data-testid 查询） */
function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function edge(from: string, to: string, port?: 'true' | 'false'): GraphEdge {
  return { id: `e_${from}_${to}_${port ?? 'out'}`, from, to, ...(port ? { port } : {}) }
}

/** 点击选项才返回：surface 保持挂载直到用户作答（隔离 ask 帧的挂载/卸载时序） */
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

/** 顺序遍历题单 + 累加 scoreDelta + score>=20 通过（与 session.test.ts 的 askAllFlow 同构） */
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

/** 可交互最小关：2 行（2 题）ask 流程，点击选项作答 */
function playableDoc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.content.types[0].behavior = clickToAnswer()
  doc.content.flow = askAllFlow()
  return doc
}

/** 订阅快照的最小舞台壳（等价于播放层内部的接线；用于直接驱动 LevelStageV4） */
function StageHarness({ session }: { session: V4Session }) {
  const snapshot = useV4Snapshot(session)
  if (!snapshot) return null
  return <LevelStageV4 session={session} snapshot={snapshot} />
}

function trackSession(doc: LevelDocV4, options: { onFinished?(result: RunResult): void; onRunEvent?(event: V4RunEvent): void } = {}): V4Session {
  return new V4Session(
    doc,
    createV4SessionHost({
      onFinished: options.onFinished ?? (() => {}),
      onRunEvent: options.onRunEvent,
      runEffects: SILENT_EFFECTS,
    }),
  )
}

describe('LevelRunnerV4（播放层组合 / DOM 契约）', () => {
  it('shell 常驻 + ask 挂载 surface + 进度 + 结算条 + 重玩复位（含绑定实时更新）', async () => {
    const doc = playableDoc()
    const finished: RunResult[] = []
    const container = renderEl(
      <LevelRunnerV4 doc={doc} levelId="res_v4_runtime_test" onFinished={(result) => finished.push(result)} />,
    )

    // 结构契约：runner → head（进度）→ 舞台（.stage-viewport/.stage-canvas）→ foot
    expect(container.querySelector('.level-runner')).not.toBeNull()
    expect(container.querySelector('.level-head .level-progress')).not.toBeNull()
    expect(container.querySelector('.stage-viewport')).not.toBeNull()
    expect(container.querySelector('.stage-canvas')).not.toBeNull()

    // 第一题 ask 帧挂载：shell 层（常驻）+ surface 层（题面/选项）分层渲染
    await waitFor(() => container.querySelector('.v4-surface') !== null, '第一帧 surface 挂载')
    expect(container.querySelector('.v4-shell')).not.toBeNull()
    // shell 绑定初值：挂载即应用（不等命令），label 显示 v.score 初值
    expect(text(container.querySelector('.v4-shell .comp-label'))).toBe('得分: 0')
    // surface 绑定：题面/选项来自 q 内容（choice.options 初值必须渲染出选项，W3.4 回归）
    expect(text(container.querySelector('.v4-surface .comp-label'))).toBe('听一听，这是什么音？')
    expect(container.querySelectorAll('.v4-surface .choice-item')).toHaveLength(3)
    expect(text(container.querySelector('.level-progress-text'))).toBe('1 / 2')

    // 作答第一题 → 返回后整帧卸载；第二题是新帧（callId 变化 → DOM 重建）
    const firstFrame = container.querySelector('.v4-surface') as HTMLElement
    await act(async () => {
      ;(container.querySelectorAll('.v4-surface .choice-item')[0] as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await waitFor(() => text(container.querySelector('.v4-surface .comp-label')) === '再听一个', '第二帧挂载')
    expect(container.querySelector('.v4-surface')).not.toBe(firstFrame)
    expect(container.querySelectorAll('.v4-surface .choice-item')).toHaveLength(2)
    expect(text(container.querySelector('.level-progress-text'))).toBe('2 / 2')

    // 作答第二题 → 结算：.result-bar pass + 分数；surface 卸载而 shell 仍渲染（绑定已更新）
    await act(async () => {
      ;(container.querySelectorAll('.v4-surface .choice-item')[0] as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await waitFor(() => container.querySelector('.result-bar') !== null, '结算条出现')
    const resultBar = container.querySelector('.result-bar') as HTMLElement
    expect(resultBar.className).toContain('pass')
    expect(text(resultBar)).toContain('通过')
    expect(text(resultBar)).toContain('得分 20')
    expect(finished).toEqual([{ score: 20, passed: true }])
    expect(container.querySelector('.v4-surface')).toBeNull() // 返回后卸载
    expect(container.querySelector('.v4-shell')).not.toBeNull() // 结算后 shell 仍渲染
    expect(text(container.querySelector('.v4-shell .comp-label'))).toBe('得分: 20')
    expect(text(container.querySelector('.level-progress-text'))).toBe('2 / 2')

    // 重玩：按钮调 session.restart() → 结果条消失、分数/进度复位、重新从第一题开始
    await act(async () => {
      ;(container.querySelector('[data-testid="v4-replay"]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    await waitFor(() => container.querySelector('.v4-surface') !== null, '重玩后第一帧重新挂载')
    expect(container.querySelector('.result-bar')).toBeNull()
    expect(text(container.querySelector('.v4-surface .comp-label'))).toBe('听一听，这是什么音？')
    expect(text(container.querySelector('.v4-shell .comp-label'))).toBe('得分: 0')
    expect(text(container.querySelector('.level-progress-text'))).toBe('1 / 2')
    expect(finished).toHaveLength(1) // 重玩不重复上报上一轮结算
  })

  it('题型内视图（v4.1）：surface 只渲染当前视图组件；下一题回到初始视图', async () => {
    const doc = minimalLevelDoc()
    doc.content.types[0].surface.views = [{ id: 'intro', name: '读题' }, { id: 'answer', name: '作答' }]
    doc.content.types[0].surface.initialView = 'intro'
    doc.content.types[0].surface.components[0].view = 'intro'
    doc.content.types[0].surface.components[1].view = 'answer'
    doc.content.types[0].surface.components.push({ id: 'goBtn', type: 'button', props: { text: '开始作答' } })
    doc.content.types[0].behavior = {
      logicVersion: 3,
      kind: 'behavior',
      nodes: [
        { id: 'b_start', kind: 'on', event: 'start' },
        { id: 'b_onGo', kind: 'on', event: 'goBtn.clicked' },
        { id: 'b_view', kind: 'setView', view: 'answer' },
        { id: 'b_on', kind: 'on', event: 'choice1.chosen' },
        { id: 'b_ret', kind: 'return', result: "{ status: 'answered', scoreDelta: 10 }" },
      ],
      edges: [edge('b_onGo', 'b_view'), edge('b_on', 'b_ret')],
    }
    doc.content.flow = askAllFlow()

    const session = trackSession(doc)
    session.start()
    renderEl(<StageHarness session={session} />)
    await waitFor(() => document.querySelector('.v4-surface')?.getAttribute('data-view') === 'intro', '初始视图 intro')
    // intro：题面渲染、选项不渲染；goBtn 未声明 view → 所有视图可见
    expect(text(document.querySelector('.v4-surface .comp-label'))).toBe('听一听，这是什么音？')
    expect(document.querySelectorAll('.v4-surface .choice-item')).toHaveLength(0)
    expect(document.querySelector('.v4-surface .comp-button')).not.toBeNull()

    await act(async () => {
      session.dispatchSurfaceEvent('goBtn', 'clicked')
    })
    await waitFor(() => document.querySelector('.v4-surface')?.getAttribute('data-view') === 'answer', '切到作答视图')
    expect(document.querySelector('.v4-surface .comp-label')).toBeNull()
    expect(document.querySelectorAll('.v4-surface .choice-item')).toHaveLength(3)

    await act(async () => {
      session.dispatchSurfaceEvent('choice1', 'chosen', { index: 0 })
    })
    await waitFor(() => document.querySelector('.v4-surface')?.getAttribute('data-view') === 'intro', '下一题回到初始视图')
    expect(text(document.querySelector('.v4-surface .comp-label'))).toBe('再听一个')
    session.dispose()
  })

  it('无题型调用时不渲染 surface 层；shell 事件经 waitShell 驱动流程（视图过滤生效）', async () => {
    const doc = minimalLevelDoc()
    doc.content.shell.views.push({ id: 'other', name: '其它视图' })
    doc.content.shell.components.push(
      {
        id: 'shellBtn',
        type: 'button',
        name: '继续',
        view: 'main',
        layout: { x: 20, y: 120, w: 140, h: 36 },
        props: { text: '继续' },
      },
      {
        id: 'otherLabel',
        type: 'label',
        name: '其它视图',
        view: 'other',
        layout: { x: 20, y: 120, w: 240, h: 32 },
        props: { text: '其它视图组件' },
      },
    )
    doc.content.flow = {
      logicVersion: 3,
      kind: 'flow',
      nodes: [
        { id: 'f_start', kind: 'start' },
        { id: 'f_wait', kind: 'waitShell', event: 'shellBtn.clicked' },
        { id: 'f_finish', kind: 'finish' },
      ],
      edges: [edge('f_start', 'f_wait'), edge('f_wait', 'f_finish')],
      vars: [{ key: 'score', type: 'number', init: 0 }],
    }
    const finished: RunResult[] = []
    const session = trackSession(doc, { onFinished: (result) => finished.push(result) })
    try {
      session.start()
      const container = renderEl(<StageHarness session={session} />)
      expect(container.querySelector('.v4-surface')).toBeNull() // 无题型调用 → 不渲染 surface 层
      expect(text(container.querySelector('.v4-shell .comp-label'))).toBe('得分: 0')
      expect(container.querySelector('.v4-shell .comp-button')).not.toBeNull()
      expect(text(container)).not.toContain('其它视图组件') // 非当前视图组件不渲染
      // 流程异步推进到 waitShell 后才可派发（start() 的 runLoop 在微任务里注册 waiter）
      await waitFor(() => session.waitingShellEvents.length === 1, '流程停在 waitShell')
      await act(async () => {
        ;(container.querySelector('.v4-shell .comp-button') as HTMLElement).dispatchEvent(
          new MouseEvent('click', { bubbles: true }),
        )
      })
      await waitFor(() => finished.length === 1, 'shell 事件唤醒 waitShell → 结算')
      expect(finished[0]).toEqual({ score: 0, passed: true })
    } finally {
      session.dispose()
    }
  })
})

describe('LevelStageV4 · 绑定初值/失败降级（W3.4 spike S1）', () => {
  it('surface 绑定求值失败：降级为静态 props + 单次运行日志，题目不中断、不写 console', async () => {
    const doc = playableDoc()
    const prompt = doc.content.types[0].surface.components[0]
    prompt.props = { text: '静态题面' }
    prompt.bindings = { text: 'q.prompt +' } // 语法错误 → 该槽位跳过（每组件槽位只记一次）
    const events: V4RunEvent[] = []
    const session = trackSession(doc, { onRunEvent: (event) => events.push(event) })
    try {
      session.start()
      const container = renderEl(<StageHarness session={session} />)
      await waitFor(() => container.querySelector('.v4-surface') !== null, 'surface 挂载')
      expect(text(container.querySelector('.v4-surface .comp-label'))).toBe('静态题面')
      expect(container.querySelectorAll('.v4-surface .choice-item')).toHaveLength(3) // 其它绑定不受影响
      const bindingWarnings = events.filter(
        (event) => event.kind === 'warning' && (event.message ?? '').includes('绑定求值失败'),
      )
      expect(bindingWarnings).toHaveLength(1)
    } finally {
      session.dispose()
    }
  })
})
