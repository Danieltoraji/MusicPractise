// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LevelDoc } from '../../engine/level'
import { GraphEditor } from './GraphEditor'
import { getDebugSnapshot, startDebugRun, stopDebugRun } from './debugRun'
import { addComponent, blankLevelDoc } from '../docState'

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

  it('G1：编辑布局工具条含窄屏守卫提示（CSS 在 index.css 文件尾控制显隐）', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const tip = container.querySelector('.graph-narrow-tip')
    expect(tip?.textContent).toContain('窄屏：节点图可横向滚动查看面板，建议 ≥1280px')
  })

  it('E19 回归：契约白名单按组件类型生效——基座命令/未知类型不误报，真实未知方法仍红标', () => {
    const doc = baseDoc()
    doc.content.components.push(
      { id: 'btn1', type: 'button', view: 'main' } as never,
      { id: 'myst1', type: 'mystery-widget', view: 'main' } as never,
    )
    doc.content.logic.nodes.push(
      { id: 'on_btn', kind: 'on', event: 'btn1.clicked', x: 0, y: 160 },
      // setVisible 是基座命令（不在 button 契约里，运行时有）——不得红标
      { id: 'c_base', kind: 'call', target: 'btn1', method: 'setVisible', args: ['{visible: true}'], x: 300, y: 160 },
      { id: 'c_base2', kind: 'call', target: 'btn1', method: 'setEnabled', args: ['{enabled: false}'], x: 600, y: 160 },
      // 未知组件类型：契约查不到即跳过校验，不得红标
      { id: 'on_myst', kind: 'on', event: 'myst1.zapped', x: 0, y: 320 },
      { id: 'c_myst', kind: 'call', target: 'myst1', method: 'whatever', args: [], x: 300, y: 320 },
    )
    doc.content.logic.edges.push(
      { id: 'e2', from: 'on_btn', to: 'c_base' },
      { id: 'e3', from: 'c_base', to: 'c_base2' },
      { id: 'e4', from: 'on_myst', to: 'c_myst' },
    )
    const bad = {
      ...doc,
      content: {
        ...doc.content,
        logic: {
          ...doc.content.logic,
          nodes: doc.content.logic.nodes.map((n) => (n.id === 'c_base' ? { ...n, method: 'setVisibel' } : n)),
        },
      },
    } as unknown as LevelDoc

    const errorIds = (c: HTMLElement): string[] =>
      [...c.querySelectorAll('[data-testid^="graph-card-"]')]
        .filter((el) => el.classList.contains('has-error') || el.querySelector('.gnode-badge') !== null)
        .map((el) => (el.getAttribute('data-testid') ?? '').replace(/^graph-card-/, ''))

    const container = renderEl(<GraphEditor doc={doc} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    expect(container.querySelector('[data-testid="graph-card-c_base"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="graph-card-c_base2"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="graph-card-c_myst"]')).toBeTruthy()
    expect(errorIds(container)).not.toContain('c_base')
    expect(errorIds(container)).not.toContain('c_base2')
    expect(errorIds(container)).not.toContain('c_myst')

    const container2 = renderEl(<GraphEditor doc={bad} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    expect(container2.querySelector('[data-testid="graph-card-c_base"]')).toBeTruthy()
    expect(errorIds(container2)).toContain('c_base')
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

  it('O9 回归：同一 task 内连续两次编辑以最新 pending doc 为基线，不丢前一笔', () => {
    // 背景：onNodesChange/onEdgesChange（或两次快速编辑）在同一 task 内先后触发时，
    // 第二次 apply 若以渲染期闭包 doc 为基线会覆盖第一次修改。修复 = pendingDocRef 单基线。
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
    const addBtn = [...container.querySelectorAll('.glib-item')].find((b) => b.textContent?.includes('进入下一题'))!
    act(() => {
      ;(addBtn as HTMLElement).click()
      ;(addBtn as HTMLElement).click()
    })
    expect(onChange).toHaveBeenCalledTimes(2)
    const calls = onChange.mock.calls.map((c) => c[0] as LevelDoc)
    expect(calls[0].content.logic.nodes).toHaveLength(3)
    // 第二次提交必须包含第一次新增节点（基线是最新 pending doc，而不是旧 prop）
    expect(calls[1].content.logic.nodes).toHaveLength(4)
    expect(calls[1].content.logic.nodes.filter((n) => n.kind === 'call' && n.method === 'next')).toHaveLength(2)
  })

  it('点击选中节点后按 Delete 删除该节点（受控 select 回填是删除前提）', async () => {
    // 回归背景：受控模式下 select change 被宿主忽略 → 画布选区恒空
    // → Delete 删不掉任何东西。修复 = select change 回填到受控 nodes + 自有 window 键监听删除。
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
    const card = container.querySelector('[data-testid="graph-card-on1"]')
    expect(card).toBeTruthy()
    // 选中 on1（RF 发 select change → 宿主回填受控 nodes 的 selected）
    act(() => card!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // Delete → 自有 window 监听 → removeNode 级联断边
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(onChange).toHaveBeenCalled()
    expect(doc.content.logic.nodes.map((n) => n.id)).toEqual(['as1'])
    expect(doc.content.logic.edges).toHaveLength(0)
  })

  it('输入控件聚焦时按 Delete 不删节点（文本编辑优先）', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
    // 选中 as1（assign 节点 → Inspector 有表达式输入框）
    const card = container.querySelector('[data-testid="graph-card-as1"]')!
    act(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // Inspector 出现（选中 on1）——事件表达式输入框聚焦时按 Delete 不删
    const input = container.querySelector('.ginsp input, .ginsp textarea') as HTMLElement | null
    expect(input).toBeTruthy()
    act(() => {
      input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(doc.content.logic.nodes).toHaveLength(2)
  })

  it('E11 回归：焦点在 Inspector 的 SELECT（或按钮）上按 Backspace/Delete 不删节点', () => {
    let doc = baseDoc()
    const onChange = vi.fn((next: LevelDoc) => {
      doc = next
    })
    const container = renderEl(<GraphEditor doc={doc} onChange={onChange} aiOpen={false} onToggleAi={() => {}} />)
    const card = container.querySelector('[data-testid="graph-card-on1"]')!
    act(() => card.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    // 选中 on1 → Inspector 的事件下拉；聚焦下拉按删除键：修复前 SELECT 不在守卫清单，节点被误删
    const select = container.querySelector('.ginsp select') as HTMLSelectElement | null
    expect(select).toBeTruthy()
    act(() => {
      select!.focus()
      select!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))
    })
    expect(onChange).not.toHaveBeenCalled()
    expect(doc.content.logic.nodes).toHaveLength(2)
    // 焦点回到画布态（window）按 Delete 仍可删——守卫没有把删除功能关掉
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }))
    })
    expect(onChange).toHaveBeenCalled()
  })

  it('E2 回归：切 ☀/🌙 主题与 A/中 摘要即刻作用于节点卡（rfNodes 依赖曾漏 theme/summaryMode）', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const band = () => container.querySelector('.gnode-band') as HTMLElement
    // assign 节点的摘要在 en/zh 两模式必然不同（'v.score = …' vs '把 v.score 设为 …'）；
    // on 节卡的事件中文名两种模式同文，不适合做断言锚点
    const bodyText = () => [...container.querySelectorAll('.gnode-body')].map((b) => b.textContent).join('|')
    const darkBand = band().style.background
    const enText = bodyText()

    const themeBtn = [...container.querySelectorAll('.graph-toolbar button')].find((b) =>
      (b as HTMLElement).title.includes('切换为浅色主题'),
    )!
    act(() => (themeBtn as HTMLElement).click())
    // 修复前：rfNodes useMemo 漏 theme 依赖——根类名已切浅色，节点卡仍持深色内联色带
    expect(band().style.background).not.toBe(darkBand)
    expect((themeBtn as HTMLButtonElement).title).toContain('切换为深色主题')

    const sumBtn = [...container.querySelectorAll('.graph-toolbar button')].find((b) => b.textContent === 'A' || b.textContent === '中')!
    act(() => (sumBtn as HTMLElement).click())
    expect(bodyText()).not.toBe(enText) // 摘要语言随切换即时刷新（修复前要等下一次编辑/拖拽）
  })

  it('E5 回归：非结构化图「查看脚本」浮层显示错误信息而不是空白', () => {
    const doc = baseDoc()
    // 多路径汇入（branch 两臂汇到 z1 再回跳）：generateScript 抛错——修复前错误字段从未接线，
    // 浮层只有空 <pre>，用户以为图没有逻辑
    const logic = doc.content.logic as unknown as { nodes: unknown[]; edges: unknown[] }
    logic.nodes = [
      { id: 'on1', kind: 'on', event: 'level.started' },
      { id: 'br', kind: 'branch', cond: 'v.go' },
      { id: 'c1', kind: 'call', target: 'sound1', method: 'play', args: [] },
      { id: 'c2', kind: 'call', target: 'sound1', method: 'stop', args: [] },
      { id: 'z1', kind: 'assign', target: 'score', value: { expr: '2' } },
    ]
    logic.edges = [
      { id: 'e1', from: 'on1', to: 'br' },
      { id: 'e2', from: 'br', to: 'c1', port: 'true' },
      { id: 'e3', from: 'br', to: 'c2', port: 'false' },
      { id: 'e4', from: 'c1', to: 'z1' },
      { id: 'e5', from: 'c2', to: 'z1' },
      { id: 'e6', from: 'z1', to: 'c1' },
    ]
    const container = renderEl(<GraphEditor doc={doc} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const btn = [...container.querySelectorAll('.graph-toolbar button')].find((b) => b.textContent === '查看脚本')!
    act(() => (btn as HTMLElement).click())
    const overlay = container.querySelector('.graph-script-overlay')
    expect(overlay).toBeTruthy()
    expect(overlay!.querySelector('.tone-error')?.textContent).toContain('多条路径汇入')
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
    const btn = [...container.querySelectorAll('[data-testid^="graph-panel-toggle-"]')].find((b) => b.textContent?.includes(label))
    if (!btn) throw new Error(`找不到面板切换按钮 ${label}`)
    return btn as HTMLButtonElement
  }
  const titles = (container: HTMLElement): string[] =>
    [...container.querySelectorAll('.gdock-title, .ai-panel-head b')].map((e) => e.textContent ?? '')

  /** 真实浏览器/合成事件通用的分隔条拖拽（pointerdown→moves→up，window 级监听） */
  function dragSplit(split: Element, deltas: number[], axis: 'x' | 'y' = 'x'): void {
    const r = split.getBoundingClientRect()
    const start = axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2
    const at = axis === 'x' ? (v: number) => ({ clientX: start + v, clientY: 0 }) : (v: number) => ({ clientX: 0, clientY: start + v })
    act(() => {
      split.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, ...at(0) }))
      for (const d of deltas) split.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, ...at(d) }))
      split.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, ...at(deltas.at(-1) ?? 0) }))
    })
  }
  const dockOf = (container: HTMLElement, title: string): Element => {
    // 按标题精确匹配（面板正文的「变量赋值」等组名会误匹配子串）
    const el = [...container.querySelectorAll('.gdock')].find((d) => {
      const t = d.querySelector('.gdock-title')
      return t?.textContent?.includes(title)
    })
    if (!el) throw new Error(`找不到面板 ${title}`)
    return el
  }

  it('默认渲染五个 dock 面板（左栏堆叠+右侧两列）与工具栏切换按钮', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    expect(container.querySelectorAll('.gdock')).toHaveLength(4) // 组件库/事件管理/变量/属性
    expect(titles(container)).toEqual(['🧩 组件库', '⚡ 事件管理', '🧮 变量', '⚙ 属性'])
    expect(container.querySelectorAll('.graph-dock-col')).toHaveLength(2) // 左 + 右A（AI 关闭）
    expect(container.querySelectorAll('.gsplit:not(.gsplit-h)')).toHaveLength(2) // 左列尾 + 右A列头（AI 关）
    expect(container.querySelectorAll('.gsplit-h')).toHaveLength(2) // 左栏内两道高度条
  })

  it('工具栏切换：事件面板隐藏再显示；✕ 关闭后按钮取消激活，再点恢复；持久化到 graph-dock', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    act(() => toggleBtn(container, '事件').click())
    expect(titles(container)).not.toContain('⚡ 事件管理')
    expect(localStorage.getItem('graph-dock')).toContain('"events":true')
    act(() => toggleBtn(container, '事件').click())
    expect(titles(container)).toContain('⚡ 事件管理')
    // 面板 ✕ 关闭 → 按钮取消激活；按钮再点 → 恢复
    act(() => (dockOf(container, '事件管理').querySelector('.gdock-close') as HTMLElement).click())
    expect(titles(container)).not.toContain('⚡ 事件管理')
    expect(toggleBtn(container, '事件').classList.contains('active')).toBe(false)
    act(() => toggleBtn(container, '事件').click())
    expect(titles(container)).toContain('⚡ 事件管理')
  })

  it('左栏三面板全隐时左栏与分隔条消失；显隐配置从 localStorage 恢复', () => {
    localStorage.setItem('graph-dock', JSON.stringify({ hidden: { library: true, events: true, vars: true } }))
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    expect(container.querySelectorAll('.graph-dock-col')).toHaveLength(1) // 只剩右A
    expect(container.querySelectorAll('.gsplit:not(.gsplit-h)')).toHaveLength(1)
    act(() => toggleBtn(container, '组件库').click())
    expect(container.querySelectorAll('.graph-dock-col')).toHaveLength(2)
  })

  it('宽度持久化：localStorage 中的列宽驱动内联样式并钳制', () => {
    localStorage.setItem('graph-panel-w-left', '260')
    localStorage.setItem('graph-panel-w-insp', '9999')
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const cols = [...container.querySelectorAll('.graph-dock-col')] as HTMLElement[]
    expect(cols[0].style.width).toBe('260px')
    expect(cols[1].style.width).toBe('460px') // 超上限被钳到 460
  })

  it('拖拽方向：左栏右拖变宽；右列左拖变宽（原符号反了的回归）', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const [leftSplit, inspSplit] = [...container.querySelectorAll('.gsplit:not(.gsplit-h)')]
    // 左栏分隔条：向右 +60 → 左栏 260
    dragSplit(leftSplit, [30, 60])
    expect((container.querySelector('.graph-dock-col') as HTMLElement).style.width).toBe('260px')
    // 属性列（右A）分隔条：向左 -60 → 300+60=360（向左拖变宽）
    dragSplit(inspSplit, [-30, -60])
    const cols = [...container.querySelectorAll('.graph-dock-col')] as HTMLElement[]
    expect(cols[1].style.width).toBe('360px')
  })

  it('拖拽跟手：连续多帧位移按「起始值+总位移」收敛，无复利漂移（回归）', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const [leftSplit] = [...container.querySelectorAll('.gsplit:not(.gsplit-h)')]
    // 5 帧累计 +100：正确结果 300（若按逐帧累加当前值会得到远超 300 的漂移值）
    dragSplit(leftSplit, [20, 40, 60, 80, 100])
    expect((container.querySelector('.graph-dock-col') as HTMLElement).style.width).toBe('300px')
    expect(localStorage.getItem('graph-panel-w-left')).toBe('300')
  })

  it('面板自由调换：拖「事件管理」标题栏到 AI 列 → 落位右B 并持久化', async () => {
    const onToggleAi = vi.fn()
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen onToggleAi={onToggleAi} />)
    // AiPanel 为 lazy：先等它渲染（列与标题栏都在其后出现）
    await act(async () => {
      for (let i = 0; i < 50 && !container.querySelector('.ai-panel-head'); i++) {
        await new Promise((r) => setTimeout(r, 10))
      }
    })
    // 拖拽源：事件管理标题栏
    const evHead = dockOf(container, '事件管理').querySelector('.gdock-head') as HTMLElement
    act(() => evHead.dispatchEvent(new Event('dragstart', { bubbles: true })))
    // 目标：AI 面板标题栏 dragover（jsdom 中 rect 全 0 → 判定插入其后）再 drop 到其列
    const cols = [...container.querySelectorAll('.graph-dock-col')]
    const aiCol = cols[2]
    act(() => {
      const aiHead = aiCol.querySelector('.ai-panel-head') as HTMLElement
      aiHead.dispatchEvent(new Event('dragover', { bubbles: true }))
      aiCol.dispatchEvent(new Event('dragover', { bubbles: true }))
      aiCol.dispatchEvent(new Event('drop', { bubbles: true }))
    })
    // 布局更新：事件管理移入右B 并持久化
    const stored = JSON.parse(localStorage.getItem('graph-dock')!) as { layout: { left: string[]; rightB: string[] } }
    expect(stored.layout.left).not.toContain('events')
    expect(stored.layout.rightB).toContain('events')
    // DOM：右B 列现在有两个面板
    const newCols = [...container.querySelectorAll('.graph-dock-col')]
    expect([...newCols[2].querySelectorAll('.gdock-title, .ai-panel-head b')].map((e) => e.textContent)).toEqual(
      expect.arrayContaining(['AI 助手', '⚡ 事件管理']),
    )
  })

  it('列内重排：拖「变量」到本列首位（插入线在组件库之前）', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const varsHead = dockOf(container, '变量').querySelector('.gdock-head') as HTMLElement
    const libHead = dockOf(container, '组件库').querySelector('.gdock-head') as HTMLElement
    // dragstart 单独一个 act：dragId 状态先 flush，后续 dragover 处理器才读得到
    act(() => varsHead.dispatchEvent(new Event('dragstart', { bubbles: true })))
    // jsdom rect 全 0：clientY=-10 < 0 → before → 变量插到组件库之前
    act(() => libHead.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientY: -10 })))
    const leftCol = container.querySelector('.graph-dock-col') as HTMLElement
    act(() => leftCol.dispatchEvent(new Event('drop', { bubbles: true })))
    expect([...leftCol.querySelectorAll('.gdock-title')].map((e) => e.textContent)).toEqual(['🧮 变量', '🧩 组件库', '⚡ 事件管理'])
  })

  it('列内高度拖拽：面板间水平分隔条调整上方面板高度并持久化', () => {
    const container = renderEl(<GraphEditor doc={baseDoc()} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const [hSplit] = [...container.querySelectorAll('.gsplit-h')]
    dragSplit(hSplit, [40], 'y')
    const lib = dockOf(container, '组件库') as HTMLElement
    expect(lib.style.height).toBe('340px')
    expect((JSON.parse(localStorage.getItem('graph-dock-h')!) as Record<string, number>).library).toBe(340)
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
    const cols = [...container.querySelectorAll('.graph-dock-col')] as HTMLElement[]
    expect(cols[2].style.width).toBe('400px')
    // 主题作用域：AI 面板是 .graph-editor.ge-dark 的后代
    expect(container.querySelector('.graph-editor.ge-dark .ai-panel')).toBeTruthy()
    expect(container.querySelectorAll('.gsplit:not(.gsplit-h)')).toHaveLength(3) // 左栏 + 右A + 右B
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

describe('调试布局（批次9 可视化）', () => {
  // 防用例失败时调试会话泄漏到其它文件/用例（模块单例跨用例存活）
  afterEach(() => {
    stopDebugRun()
  })

  // startDebugRun 走 loadLevelDoc 装载——用 blankLevelDoc（schema 合法）而非 GraphEditor 冒烟用的手拼 baseDoc
  function debugDoc(): LevelDoc {
    let doc = blankLevelDoc()
    doc = addComponent(doc, 'button', 'main')
    doc = {
      ...doc,
      content: {
        ...doc.content,
        logic: {
          logicVersion: 2,
          variables: { score: 0 },
          nodes: [
            { id: 'on1', kind: 'on', event: 'level.started', x: 0, y: 0 },
            { id: 'onb', kind: 'on', event: 'button1.clicked', x: 0, y: 160 },
            { id: 'asb', kind: 'assign', target: 'score', value: { expr: 'v.score + 1' }, x: 300, y: 160 },
          ],
          edges: [{ id: 'eb', from: 'onb', to: 'asb' }],
        },
      },
    } as unknown as LevelDoc
    return doc
  }

  it('调试会话激活：工作台切换为调试布局（停止按钮+画面），编辑 dock 消失；停止后恢复', async () => {
    const doc = debugDoc()
    await act(async () => {
      await startDebugRun(doc)
    })
    const c = renderEl(<GraphEditor doc={doc} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    // 调试布局：停止调试按钮 + 画面在左侧；编辑布局的三列（组件库标题）不存在
    expect(c.textContent).toContain('停止调试')
    expect(c.querySelector('.gdb-layout')).not.toBeNull()
    expect(c.querySelector('.gdb-stage-canvas')).not.toBeNull()
    expect(c.textContent).not.toContain('组件库')

    // 停止 → 编辑布局恢复
    const stop = [...c.querySelectorAll('.graph-toolbar button')].find((b) => b.textContent?.includes('停止调试')) as HTMLElement
    await act(async () => {
      stop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(c.querySelector('.gdb-layout')).toBeNull()
    expect(c.textContent).toContain('组件库')
    expect(getDebugSnapshot().mode).toBe('idle')
  })

  it('调试中可切「节点图」窗格（graph-canvas 在场），「画面」切回', async () => {
    const doc = debugDoc()
    await act(async () => {
      await startDebugRun(doc)
    })
    const c = renderEl(<GraphEditor doc={doc} onChange={() => {}} aiOpen={false} onToggleAi={() => {}} />)
    const tab = (label: string): HTMLElement =>
      [...c.querySelectorAll('.graph-toolbar button')].find((b) => b.textContent?.includes(label)) as HTMLElement
    await act(async () => {
      tab('节点图').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(c.querySelector('.graph-canvas')).not.toBeNull()
    expect(c.querySelector('.gdb-stage-canvas')).toBeNull()
    await act(async () => {
      tab('画面').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(c.querySelector('.gdb-stage-canvas')).not.toBeNull()
    const stop = [...c.querySelectorAll('.graph-toolbar button')].find((b) => b.textContent?.includes('停止调试')) as HTMLElement
    await act(async () => {
      stop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  })
})

