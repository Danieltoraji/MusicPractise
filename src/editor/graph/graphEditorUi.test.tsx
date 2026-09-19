// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { LevelDoc } from '../../engine/level'
import { GraphEditor } from './GraphEditor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// React Flow 依赖 ResizeObserver（jsdom 无）
beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 1200 })
  Object.defineProperty(globalThis.HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 700 })
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

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

const baseDoc = (): LevelDoc =>
  ({
    schemaVersion: 3,
    kind: 'level',
    id: 'res_x',
    version: '0.1.0',
    meta: { title: '节点图测试' },
    refs: [],
    content: {
      views: [{ id: 'main', name: '主视图', template: true }],
      components: [{ id: 'sound1', type: 'sound', visible: false, view: 'main' }],
      logic: {
        logicVersion: 2,
        variables: { score: 0 },
        nodes: [
          { id: 'on1', kind: 'on', event: 'level.started', x: 0, y: 0 },
          { id: 'as1', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' }, x: 300, y: 0 },
        ],
        edges: [{ id: 'e1', from: 'on1', to: 'as1' }],
      },
      table: { columns: [], rows: [] },
      questions: [],
      flow: {},
    },
  }) as unknown as LevelDoc

describe('GraphEditor（jsdom 冒烟）', () => {
  it('渲染节点信息卡（中文摘要印卡）与节点库分组、画布对照图', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} />)
    expect(container.textContent).toContain('事件')
    expect(container.textContent).toContain('v.score = v.score + 1')
    expect(container.textContent).toContain('当 关卡开始')
    expect(container.textContent).toContain('节点库')
    expect(container.textContent).toContain('实例动作')
    expect(container.textContent).toContain('画布对照')
    expect(container.textContent).toContain('点击组件：高亮图中引用它的节点')
  })

  it('点击节点库项添加节点（受控回写）', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} />)
    const addBtn = [...container.querySelectorAll('.glib-item')].find((b) => b.textContent?.includes('进入下一题'))!
    act(() => (addBtn as HTMLElement).click())
    expect(doc.content.logic.nodes).toHaveLength(3)
    const added = doc.content.logic.nodes.find((n) => n.kind === 'call')
    expect(added).toMatchObject({ target: 'level', method: 'next', args: [] })
  })

  it('崩溃回归：先选中 call 节点再切 assign 节点，首帧不因旧草稿崩溃且表达式可见', () => {
    // 回归背景：草稿曾用 useEffect 异步重置，切节点后的首渲染帧拿上一个节点的草稿，
    // assign 的 `'expr' in draft.value` 读到 undefined 直接白屏
    let doc = baseDoc()
    doc = {
      ...doc,
      content: {
        ...doc.content,
        logic: {
          ...doc.content.logic,
          nodes: [
            ...doc.content.logic.nodes,
            { id: 'snd1', kind: 'call', target: 'sound1', method: 'play', args: [], x: 600, y: 0 },
            { id: 'as2', kind: 'assign', target: 'score', value: { expr: '0' }, x: 900, y: 0 },
          ],
        },
      },
    }
    const container = renderEl(<GraphEditor doc={doc} onChange={() => {}} />)
    // 先点 call 节点（其草稿无 value 字段）
    const callCard = [...container.querySelectorAll('.gnode')].find((c) => c.textContent?.includes('sound1·play'))
    act(() => callCard!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // 立即切 assign 节点（渲染帧 1 就要安全）
    const assignCard = [...container.querySelectorAll('.gnode')].find((c) => c.textContent?.includes('v.score = 0'))
    act(() => assignCard!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(container.textContent).toContain('属性 · assign')
    expect(container.textContent).toContain('v.score = 0')
  })

  it('Inspector 编辑 branch 条件并回写（比较构造器：右操作数失焦提交）', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    // 初始带一个 branch 节点并预选中
    doc = {
      ...doc,
      content: {
        ...doc.content,
        logic: {
          ...doc.content.logic,
          nodes: [...doc.content.logic.nodes, { id: 'br1', kind: 'branch', cond: 'v.score >= 10', x: 600, y: 0 }],
        },
      },
    }
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} />)
    const card = [...container.querySelectorAll('.gnode')].find((el) => el.textContent?.includes('如果 v.score >= 10'))
    expect(card).toBeTruthy()
    act(() => card!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // 比较构造器：右侧数字输入框（初值 10），改为 20 后失焦提交
    const numInput = [...container.querySelectorAll('.ginsp input[type=number]')].find(
      (el) => (el as HTMLInputElement).value === '10',
    )
    expect(numInput).toBeTruthy()
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(numInput, '20')
      numInput!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => {
      numInput!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    const patched = doc.content.logic.nodes.find((n) => n.id === 'br1')
    expect(patched).toMatchObject({ kind: 'branch', cond: 'v.score >= 20' })
  })
})

/** 触发受控 select 的 change（select 的 change/input 双发，覆盖 React 的事件归一化） */
function changeSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!
  setter.call(select, value)
  select.dispatchEvent(new Event('input', { bubbles: true }))
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('Inspector 结构化编辑（3-5 友好化）', () => {
  function docWith(extraNodes: unknown[], comps?: LevelDoc['content']['components']): LevelDoc {
    const doc = baseDoc()
    return {
      ...doc,
      content: {
        ...doc.content,
        components: comps ?? doc.content.components,
        logic: { ...doc.content.logic, nodes: [...doc.content.logic.nodes, ...(extraNodes as never[])] },
      },
    }
  }

  it('on 节点：事件下拉选择即提交（不手打事件名）', () => {
    // 用「题目载入」起头避免与基础 doc 的 on1（关卡开始）摘要重名
    let doc = docWith([{ id: 'on2', kind: 'on', event: 'level.questionLoaded', x: 0, y: 200 }])
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} />)
    act(() => {
      ;[...container.querySelectorAll('.gnode')].find((c) => c.textContent?.includes('当 题目载入'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const eventSelect = [...container.querySelectorAll('.ginsp select')].find(
      (s) => (s as HTMLSelectElement).value === 'level.questionLoaded',
    )
    expect(eventSelect).toBeTruthy()
    act(() => changeSelect(eventSelect as HTMLSelectElement, 'level.finished'))
    expect(doc.content.logic.nodes.find((n) => n.id === 'on2')).toMatchObject({ event: 'level.finished' })
  })

  it('call 节点：切方法重置参数形态，「按契约补全」生成键值对', () => {
    // onChange 即用新 doc 重渲染：后续 DOM 交互（补全按钮）建立在最新 Inspector 上
    let current = docWith([{ id: 'c1', kind: 'call', target: 'sound1', method: 'stop', args: [], x: 600, y: 0 }])
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const rerender = (d: LevelDoc): void => {
      current = d
      act(() => root.render(<GraphEditor doc={d} onChange={rerender} />))
    }
    act(() => {
      root = createRoot(container)
      root.render(<GraphEditor doc={current} onChange={rerender} />)
    })
    act(() => {
      ;[...container.querySelectorAll('.gnode')].find((c) => c.textContent?.includes('sound1·stop'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // 动作下拉：stop（无参）→ play（有参）
    const methodSelect = [...container.querySelectorAll('.ginsp select')].find((s) => (s as HTMLSelectElement).value === 'stop')
    expect(methodSelect).toBeTruthy()
    act(() => changeSelect(methodSelect as HTMLSelectElement, 'play'))
    expect(current.content.logic.nodes.find((n) => n.id === 'c1')).toMatchObject({ method: 'play', args: ['{}'] })
    // 按契约补全：sound.play 的 notes/tempo/mode 键值对
    const fillBtn = [...container.querySelectorAll('.call-args-actions button')].find((b) => b.textContent?.includes('按契约补全'))
    expect(fillBtn).toBeTruthy()
    act(() => (fillBtn as HTMLElement).click())
    const args = (current.content.logic.nodes.find((n) => n.id === 'c1') as { args: string[] }).args
    expect(args[0]).toContain('notes:')
    expect(args[0]).toContain('tempo:')
    roots.push(root)
    containers.push(container)
  })

  it('assign 节点：值模式切「查询」生成 RValue.call 并可选查询方法', () => {
    const comps = [{ id: 'slider1', type: 'slider' }]
    let doc = docWith([{ id: 'as2', kind: 'assign', target: 'score', value: { expr: '0' }, x: 600, y: 0 }], comps as LevelDoc['content']['components'])
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} />)
    act(() => {
      ;[...container.querySelectorAll('.gnode')].find((c) => c.textContent?.includes('v.score = 0'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const queryBtn = [...container.querySelectorAll('.ginsp button')].find((b) => b.textContent === '查询')
    expect(queryBtn).toBeTruthy()
    act(() => (queryBtn as HTMLElement).click())
    expect(doc.content.logic.nodes.find((n) => n.id === 'as2')).toMatchObject({
      value: { call: { target: 'slider1', method: 'getValue', args: [] } },
    })
  })

  it('assign 节点：查询⇄表达式模式往返恢复原表达式（评审 P1-1 回归）', () => {
    const comps = [{ id: 'slider1', type: 'slider' }]
    // 表达式用唯一值，避免与基础 doc 的 as1（v.score + 1）摘要撞名点错节点
    let doc = docWith(
      [{ id: 'as3', kind: 'assign', target: 'score', value: { expr: 'v.score + 7' }, x: 600, y: 0 }],
      comps as LevelDoc['content']['components'],
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const rerender = (d: LevelDoc): void => {
      doc = d
      act(() => root.render(<GraphEditor doc={d} onChange={rerender} />))
    }
    act(() => {
      root = createRoot(container)
      root.render(<GraphEditor doc={doc} onChange={rerender} />)
    })
    act(() => {
      ;[...container.querySelectorAll('.gnode')].find((c) => c.textContent?.includes('v.score = v.score + 7'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const clickBtn = (label: string): void => {
      const btn = [...container.querySelectorAll('.ginsp button')].find((b) => b.textContent === label)
      if (!btn) throw new Error(`找不到按钮 ${label}`)
      act(() => (btn as HTMLElement).click())
    }
    clickBtn('查询')
    expect((doc.content.logic.nodes.find((n) => n.id === 'as3') as { value: object }).value).toHaveProperty('call')
    clickBtn('ƒx')
    expect(doc.content.logic.nodes.find((n) => n.id === 'as3')).toMatchObject({ value: { expr: 'v.score + 7' } })
    roots.push(root)
    containers.push(container)
  })
})
