// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { addComponent, blankLevelDoc } from '../editor/docState'
import type { LevelDoc } from '../engine/level'
import { ComponentStore } from './store'
import { LevelStage } from './LevelStage'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeAll(() => {
  // LevelStage 的 fit-scale 依赖 ResizeObserver（jsdom 无；observe 为 no-op → scale 走 clientWidth=0 兜底）
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
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

/** 主视图一个按钮，点击 score+1（emit 通道） */
function simpleDoc(): LevelDoc {
  let doc = blankLevelDoc()
  doc.meta.title = '舞台测试'
  doc = addComponent(doc, 'button', 'main')
  doc = {
    ...doc,
    content: {
      ...doc.content,
      logic: {
        logicVersion: 2,
        variables: { score: 0 },
        nodes: [{ id: 'on1', kind: 'on', event: 'button1.clicked' }],
        edges: [],
      },
    },
  } as LevelDoc
  return doc
}

describe('LevelStage（共享游玩舞台，批次12）', () => {
  it('渲染当前视图组件；点击组件派发真实事件', async () => {
    const doc = simpleDoc()
    const store = new ComponentStore()
    store.init(doc.content.components)
    const emits: Array<{ event: string; payload?: unknown }> = []
    const c = renderEl(
      <LevelStage
        doc={doc}
        store={store}
        emitFor={() => (event, payload) => emits.push({ event, payload })}
        view="main"
        viewportClassName="level-canvas-wrap"
        canvasClassName="level-canvas"
      />,
    )
    expect(c.querySelector('.stage-canvas')).not.toBeNull()
    const btn = c.querySelector('.stage-canvas button') as HTMLButtonElement
    expect(btn).toBeTruthy()
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(emits).toEqual([{ event: 'clicked', payload: undefined }])
  })

  it('视图过滤：其它视图的组件不渲染；view 空串回落首个视图', () => {
    const doc = simpleDoc()
    doc.content.views.push({ id: 'second', name: '第二视图' })
    doc.content.components.push({ id: 'btn2', type: 'button', view: 'second' } as never)
    const store = new ComponentStore()
    store.init(doc.content.components)
    const c = renderEl(<LevelStage doc={doc} store={store} emitFor={() => () => {}} view="" />)
    // baseDoc 补的 btn1 view=main；view 空串 → 首视图 main → 只有 btn1
    expect(c.querySelectorAll('.stage-canvas [data-midi], .stage-canvas button')).toHaveLength(1)
    expect(c.querySelector('.stage-canvas button')?.className).toContain('comp-button')
  })

  it('sessionKey 变化强制重挂画布（调试会话更替场景）', () => {
    const doc = simpleDoc()
    const store = new ComponentStore()
    store.init(doc.content.components)
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const renderWith = (sessionKey: number): HTMLElement => {
      let el!: HTMLElement
      act(() => {
        root.render(<LevelStage doc={doc} store={store} emitFor={() => () => {}} view="main" sessionKey={sessionKey} />)
      })
      el = container.querySelector('.stage-canvas') as HTMLElement
      return el
    }
    try {
      root = createRoot(container)
      const first = renderWith(1)
      const second = renderWith(2)
      expect(second).not.toBe(first) // key 变化 → DOM 节点重建
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
