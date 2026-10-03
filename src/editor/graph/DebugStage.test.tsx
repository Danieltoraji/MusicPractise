// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { addComponent, blankLevelDoc } from '../docState'
import type { LevelDoc } from '../../engine/level'
import { loadLevelDoc } from '../../library/validate'
import { getDebugSnapshot, startDebugRun, stopDebugRun } from './debugRun'
import { DebugStage } from './DebugStage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ResizeObserver：DebugStage 的 fit-scale 与 React Flow 都依赖（jsdom 无）
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
})

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

beforeEach(() => {
  localStorage.clear()
  stopDebugRun()
})

/** 最小可交互关（走 blankLevelDoc 保证 schema 合法）：主视图一个按钮，点击 score+1 */
function simpleDoc(): LevelDoc {
  let doc = blankLevelDoc()
  doc.meta.title = '调试画面测试'
  doc = addComponent(doc, 'button', 'main')
  doc = {
    ...doc,
    content: {
      ...doc.content,
      logic: {
        logicVersion: 2,
        variables: { score: 0 },
        nodes: [
          { id: 'on1', kind: 'on', event: 'button1.clicked' },
          { id: 'as1', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' } },
        ],
        edges: [{ id: 'e1', from: 'on1', to: 'as1' }],
      },
    },
  } as LevelDoc
  const check = loadLevelDoc(structuredClone(doc))
  expect(check.ok).toBe(true)
  return doc
}

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30))
  })
}

/** 轮询等待快照满足条件（vars 由 400ms 低频刷新，点击后不即时） */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25))
    })
  }
}

describe('DebugStage（批次9 调试画面）', () => {
  it('无会话时渲染空态', () => {
    const c = renderEl(<DebugStage doc={simpleDoc()} />)
    expect(c.textContent).toContain('无运行中的调试会话')
  })

  it('会话激活：渲染当前视图组件；点击画面 = 真实派发（变量随之变化）', async () => {
    const doc = simpleDoc()
    const err = await startDebugRun(doc)
    expect(err).toBeNull()
    const c = renderEl(<DebugStage doc={doc} />)

    // 顶条：标题/视图/进度 + 画布上按钮组件可见
    expect(c.textContent).toContain('调试画面测试')
    expect(c.textContent).toContain('主视图')
    expect(c.querySelector('.gdb-stage-canvas')).not.toBeNull()
    const stageBtn = c.querySelector('.gdb-stage-canvas button')
    expect(stageBtn).toBeTruthy()

    // 点击画面按钮 = session.dispatch（与 AI debug_dispatch 同路径）；vars 经 400ms 轮询进快照
    await act(async () => {
      ;(stageBtn as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => (getDebugSnapshot().vars.score ?? 0) === 1)

    stopDebugRun()
  })

  it('重开按钮调 restartDebug（变量复位、会话继续）', async () => {
    const doc = simpleDoc()
    await startDebugRun(doc)
    const c = renderEl(<DebugStage doc={doc} />)

    const stageBtn = c.querySelector('.gdb-stage-canvas button') as HTMLElement
    await act(async () => {
      stageBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor(() => (getDebugSnapshot().vars.score ?? 0) === 1)

    const retry = [...c.querySelectorAll('.gdb-stage-foot button')].find((b) => b.textContent?.includes('重开')) as HTMLElement
    await act(async () => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(getDebugSnapshot().vars.score).toBe(0)
    expect(getDebugSnapshot().mode).toBe('running')
    stopDebugRun()
  })
})
