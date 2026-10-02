// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

// dock 布局（显隐/宽度）持久化在 localStorage——用例间必须清零防串扰
beforeEach(() => {
  localStorage.clear()
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
      views: [{ id: 'main', name: '主视图' }],
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
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    expect(container.textContent).toContain('事件')
    expect(container.textContent).toContain('v.score = v.score + 1')
    expect(container.textContent).toContain('当 关卡开始')
    expect(container.textContent).toContain('节点库')
    expect(container.textContent).toContain('组件动作')
    expect(container.textContent).toContain('前往视图…') // palette 精简：通用单项
    expect(container.textContent).toContain('事件') // 事件面板（取代事件组）
    expect(container.textContent).toContain('画布对照')
    expect(container.textContent).toContain('点击组件：高亮图中引用它的节点')
  })

  it('点击节点库项添加节点（受控回写）', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
    const addBtn = [...container.querySelectorAll('.glib-item')].find((b) => b.textContent?.includes('进入下一题'))!
    act(() => (addBtn as HTMLElement).click())
    expect(doc.content.logic.nodes).toHaveLength(3)
    const added = doc.content.logic.nodes.find((n) => n.kind === 'call')
    expect(added).toMatchObject({ target: 'question', method: 'next', args: [] })
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
    const container = renderEl(<GraphEditor doc={doc} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
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
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
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

describe('工作台面板化（docs/29）', () => {
  const toggleBtn = (container: HTMLElement, label: string): HTMLButtonElement => {
    const btn = [...container.querySelectorAll('.graph-toolbar .gtoggle')].find((b) => b.textContent?.includes(label))
    if (!btn) throw new Error(`找不到面板切换按钮 ${label}`)
    return btn as HTMLButtonElement
  }

  it('默认渲染五个 dock 面板与工具栏切换按钮', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    expect(container.querySelectorAll('.gdock')).toHaveLength(4) // 组件库/事件管理/变量/属性
    expect([...container.querySelectorAll('.gdock-title')].map((e) => e.textContent)).toEqual([
      '🧩 组件库',
      '⚡ 事件管理',
      '🧮 变量',
      '⚙ 属性',
    ])
    expect(container.querySelectorAll('.gsplit')).toHaveLength(2) // 左栏 + 属性（AI 关闭）
  })

  it('工具栏切换：事件面板隐藏再显示；✕ 关闭后按钮取消激活，再点恢复', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    // 工具栏切换隐藏
    act(() => toggleBtn(container, '事件').click())
    expect([...container.querySelectorAll('.gdock-title')].map((e) => e.textContent)).not.toContain('⚡ 事件管理')
    expect(localStorage.getItem('graph-panels')).toContain('"events":false')
    // 再点恢复
    act(() => toggleBtn(container, '事件').click())
    expect([...container.querySelectorAll('.gdock-title')].map((e) => e.textContent)).toContain('⚡ 事件管理')
    // 面板 ✕ 关闭 → 按钮取消激活；按钮再点 → 恢复
    const dock = [...container.querySelectorAll('.gdock')].find((d) => d.textContent?.includes('事件管理'))!
    act(() => (dock.querySelector('.gdock-close') as HTMLElement).click())
    expect([...container.querySelectorAll('.gdock-title')].map((e) => e.textContent)).not.toContain('⚡ 事件管理')
    expect(toggleBtn(container, '事件').classList.contains('active')).toBe(false)
    act(() => toggleBtn(container, '事件').click())
    expect([...container.querySelectorAll('.gdock-title')].map((e) => e.textContent)).toContain('⚡ 事件管理')
  })

  it('左栏三面板全隐时左栏与分隔条消失；显隐配置从 localStorage 恢复', () => {
    localStorage.setItem('graph-panels', JSON.stringify({ library: false, events: false, vars: false, inspector: true }))
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    expect(container.querySelector('.graph-left')).toBeNull()
    expect(container.querySelectorAll('.gsplit')).toHaveLength(1) // 只剩属性列的
    // 恢复一个
    act(() => toggleBtn(container, '组件库').click())
    expect(container.querySelector('.graph-left')).toBeTruthy()
  })

  it('宽度持久化：localStorage 中的列宽驱动内联样式并钳制', () => {
    localStorage.setItem('graph-panel-w-left', '260')
    localStorage.setItem('graph-panel-w-insp', '9999')
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const left = container.querySelector('.graph-left') as HTMLElement
    expect(left.style.width).toBe('260px')
    const insp = container.querySelector('.graph-right-col') as HTMLElement
    expect(insp.style.width).toBe('460px') // 超上限被钳到 460
  })

  it('AI 入坞：aiOpen=true 时 AI 面板渲染在 .graph-editor 内（主题作用域），列宽可配；onToggleAi 由工具栏按钮触发', async () => {
    const onToggleAi = vi.fn()
    localStorage.setItem('graph-panel-w-ai', '400')
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen onToggleAi={onToggleAi} />)
    // AiPanel 为 lazy：轮询等待渲染
    await act(async () => {
      for (let i = 0; i < 50 && !container.querySelector('.ai-panel'); i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
    })
    const aiCol = container.querySelector('.graph-ai-col') as HTMLElement
    expect(aiCol).toBeTruthy()
    expect(aiCol.style.width).toBe('400px')
    // 主题作用域：AI 面板是 .graph-editor.ge-dark 的后代
    expect(container.querySelector('.graph-editor.ge-dark .ai-panel')).toBeTruthy()
    expect(container.querySelectorAll('.gsplit')).toHaveLength(3) // 左栏 + 属性 + AI
    act(() => toggleBtn(container, 'AI').click())
    expect(onToggleAi).toHaveBeenCalled()
  })

  it('事件管理器：+ 处理器 / emit 落节点（受控回写）', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
    // 系统事件：点击「关卡开始」的 + 处理器（gem-add）
    const addLevel = [...container.querySelectorAll('.gem-add')].find((b) => b.textContent?.includes('关卡开始'))!
    act(() => (addLevel as HTMLElement).click())
    expect(onChange).toHaveBeenCalled()
    expect(doc.content.logic.nodes.some((n) => n.kind === 'on' && n.event === 'level.started' && n.id !== 'on1')).toBe(true)
  })
})

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
    let doc = docWith([{ id: 'on2', kind: 'on', event: 'question.loaded', x: 0, y: 200 }])
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
    act(() => {
      ;[...container.querySelectorAll('.gnode')].find((c) => c.textContent?.includes('当 题目载入'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const eventSelect = [...container.querySelectorAll('.ginsp select')].find(
      (s) => (s as HTMLSelectElement).value === 'question.loaded',
    )
    expect(eventSelect).toBeTruthy()
    act(() => changeSelect(eventSelect as HTMLSelectElement, 'level.finished'))
    expect(doc.content.logic.nodes.find((n) => n.id === 'on2')).toMatchObject({ event: 'level.finished' })
  })

  it('call 节点：切方法重置参数形态，「按契约补全」生成键值对', () => {
    // 用 button 组件（sound 的 play 已特化为音符编辑器，不走通用键值路径）
    let current = docWith([{ id: 'c1', kind: 'call', target: 'btn1', method: 'setEnabled', args: [], x: 600, y: 0 }], [
      { id: 'sound1', type: 'sound', visible: false },
      { id: 'btn1', type: 'button' },
    ] as never)
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    const rerender = (d: LevelDoc): void => {
      current = d
      act(() => root.render(<GraphEditor doc={d} onChange={rerender} aiOpen={false} onToggleAi={() => {}} />))
    }
    act(() => {
      root = createRoot(container)
      root.render(<GraphEditor doc={current} onChange={rerender} aiOpen={false} onToggleAi={() => {}} />)
    })
    act(() => {
      ;[...container.querySelectorAll('.gnode')].find((c) => c.textContent?.includes('btn1·setEnabled'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // 动作下拉：setEnabled（有参）→ setText（有参，形态保持）→ 再切
    const methodSelect = [...container.querySelectorAll('.ginsp select')].find((s) => (s as HTMLSelectElement).value === 'setEnabled')
    expect(methodSelect).toBeTruthy()
    act(() => changeSelect(methodSelect as HTMLSelectElement, 'setText'))
    expect(current.content.logic.nodes.find((n) => n.id === 'c1')).toMatchObject({ method: 'setText', args: ['{}'] })
    // 按契约补全：button.setText 的 text 键值对
    const fillBtn = [...container.querySelectorAll('.call-args-actions button')].find((b) => b.textContent?.includes('按契约补全'))
    expect(fillBtn).toBeTruthy()
    act(() => (fillBtn as HTMLElement).click())
    const args = (current.content.logic.nodes.find((n) => n.id === 'c1') as { args: string[] }).args
    expect(args[0]).toContain('text:')
    roots.push(root)
    containers.push(container)
  })

  it('assign 节点：值模式切「查询」生成 RValue.call 并可选查询方法', () => {
    const comps = [{ id: 'slider1', type: 'slider' }]
    let doc = docWith([{ id: 'as2', kind: 'assign', target: 'score', value: { expr: '0' }, x: 600, y: 0 }], comps as LevelDoc['content']['components'])
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
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
      act(() => root.render(<GraphEditor doc={d} onChange={rerender} aiOpen={false} onToggleAi={() => {}} />))
    }
    act(() => {
      root = createRoot(container)
      root.render(<GraphEditor doc={doc} onChange={rerender} aiOpen={false} onToggleAi={() => {}} />)
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
