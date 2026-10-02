// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LevelDoc } from '../../engine/level'
import { EventManagerPanel } from './EventManagerPanel'

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
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

const baseDoc = (): LevelDoc =>
  ({
    schemaVersion: 3,
    kind: 'level',
    id: 'res_em',
    version: '0.1.0',
    meta: { title: '事件管理器测试' },
    refs: [],
    content: {
      views: [{ id: 'main', name: '主视图' }],
      components: [
        { id: 'btn1', type: 'button', name: '确认' },
        { id: 'sound1', type: 'sound', visible: false },
      ],
      logic: {
        logicVersion: 2,
        variables: {},
        nodes: [
          { id: 'on1', kind: 'on', event: 'app:hint' },
          { id: 'em1', kind: 'emit', event: 'app:burst' },
        ],
        edges: [],
      },
      table: { columns: [], rows: [] },
      flow: {},
    },
  }) as unknown as LevelDoc

function setup() {
  const onAddOn = vi.fn()
  const onAddEmit = vi.fn()
  const onFocusNode = vi.fn()
  const doc = baseDoc()
  const container = renderEl(<EventManagerPanel doc={doc} onAddOn={onAddOn} onAddEmit={onAddEmit} onFocusNode={onFocusNode} />)
  return { container, onAddOn, onAddEmit, onFocusNode }
}

const findRow = (container: HTMLElement, text: string): Element => {
  const row = [...container.querySelectorAll('.gem-row')].find((r) => r.textContent?.includes(text))
  if (!row) throw new Error(`找不到事件行 ${text}`)
  return row
}

describe('EventManagerPanel（派生式事件注册表）', () => {
  it('渲染系统/组件/内部三分组，含组件实例名与派生内部事件', () => {
    const { container } = setup()
    expect(container.textContent).toContain('关卡')
    expect(container.textContent).toContain('题目')
    expect(container.textContent).toContain('组件事件')
    expect(container.textContent).toContain('确认 · clicked')
    expect(container.textContent).toContain('内部事件')
    expect(container.textContent).toContain('app:hint')
    expect(container.textContent).toContain('app:burst')
  })

  it('+ 处理器：系统与组件事件都回调 onAddOn', () => {
    const { container, onAddOn } = setup()
    act(() => (findRow(container, '关卡开始').querySelector('.gem-add') as HTMLElement).click())
    expect(onAddOn).toHaveBeenCalledWith('level.started')
    act(() => (findRow(container, '确认 · clicked').querySelector('.gem-add') as HTMLElement).click())
    expect(onAddOn).toHaveBeenCalledWith('btn1.clicked')
  })

  it('emit 按钮只出现在内部事件行；定位只对有处理器的内部事件可用', () => {
    const { container, onFocusNode } = setup()
    // 系统/组件事件无 emit 按钮
    expect(findRow(container, '关卡开始').querySelector('.gem-act')).toBeNull()
    // app:hint 有 on 处理器（on1）→ 定位可用；app:burst 只有 emit → 定位禁用
    const hintRow = findRow(container, 'app:hint')
    const burstRow = findRow(container, 'app:burst')
    expect((burstRow.querySelector('.gem-act[disabled]') as HTMLButtonElement)?.disabled).toBe(true)
    act(() => ([...hintRow.querySelectorAll('.gem-act')].find((b) => b.textContent === '定位') as HTMLElement).click())
    expect(onFocusNode).toHaveBeenCalledWith('on1')
  })

  it('emit 动作回调 onAddEmit（仅内部事件）', () => {
    const { container, onAddEmit } = setup()
    const hintRow = findRow(container, 'app:hint')
    act(() => ([...hintRow.querySelectorAll('.gem-act')].find((b) => b.textContent === 'emit') as HTMLElement).click())
    expect(onAddEmit).toHaveBeenCalledWith('app:hint')
  })

  it('新增内部事件：合法名落处理器；非法名/重名给出错误且不回调', () => {
    const { container, onAddOn } = setup()
    const input = container.querySelector('.gem-new input') as HTMLInputElement
    const add = container.querySelector('.gem-new button') as HTMLButtonElement
    const type = (v: string): void =>
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, v)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })

    type('不合法的名字')
    act(() => add.click())
    expect(container.querySelector('.gem-err')?.textContent).toContain('名:名')
    expect(onAddOn).not.toHaveBeenCalled()

    type('app:hint') // 已存在
    act(() => add.click())
    expect(container.querySelector('.gem-err')?.textContent).toContain('已在图中使用')

    type('game:combo')
    act(() => add.click())
    expect(onAddOn).toHaveBeenCalledWith('game:combo')
    expect(container.querySelector('.gem-err')).toBeNull()
  })

  it('搜索过滤：无匹配时空态', () => {
    const { container } = setup()
    const input = container.querySelector('.gmenu-filter') as HTMLInputElement
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '不存在的 xyz')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('没有匹配的事件')
  })
})
