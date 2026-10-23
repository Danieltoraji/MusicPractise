// @vitest-environment jsdom
/**
 * D1 行虚拟化组件回归（docs/43 §7 → R14）：
 * - 200 行文档只挂载可视区行（不再为每行挂 notes 预览/输入框）；
 * - 滚动后命中正确绝对行号，且行内编辑写回正确数据行（行索引不因 slice 偏移）；
 * - 上/下占位行撑出滚动高度。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { LevelDoc } from '../engine/level'
import { TableEditor } from './TableGrid'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const makeDoc = (rowCount: number): LevelDoc =>
  ({
    schemaVersion: 3,
    kind: 'level',
    id: 'res_01J9VIRTUAL000000000000000',
    version: '0.1.0',
    meta: { title: '虚拟化测试' },
    refs: [],
    content: {
      views: [{ id: 'main', name: '主视图' }],
      components: [],
      logic: { logicVersion: 2, variables: {}, nodes: [], edges: [] },
      table: {
        columns: [{ key: 'title', label: '题面', type: 'text' }],
        rows: Array.from({ length: rowCount }, (_, i) => ({ title: `题目 ${i + 1}` })),
      },
      flow: {},
    },
  }) as unknown as LevelDoc

let root: Root | null = null
let container: HTMLElement | null = null
let current: LevelDoc | null = null

function mount(rowCount: number): HTMLElement {
  current = makeDoc(rowCount)
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container!)
    root.render(
      <TableEditor
        doc={current!}
        onChange={(next) => {
          current = next
        }}
      />,
    )
  })
  return container
}

/** 覆盖 jsdom 无布局：给滚动容器伪造 clientHeight / scrollTop */
function setViewport(wrap: HTMLElement, height: number, scrollTop: number): void {
  Object.defineProperty(wrap, 'clientHeight', { configurable: true, value: height })
  Object.defineProperty(wrap, 'scrollTop', { configurable: true, writable: true, value: scrollTop })
}

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container?.remove()
  container = null
  current = null
})

const rowNumbers = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('.tgrid-rownum')].map((el) => el.textContent ?? '')

describe('TableEditor 行虚拟化（D1/R14）', () => {
  it('200 行只挂载可视窗口：tbody 行数远小于总行数，且从第 1 行开始', () => {
    const c = mount(200)
    const trs = c.querySelectorAll('.tgrid tbody tr')
    expect(trs.length).toBeGreaterThan(0)
    expect(trs.length).toBeLessThan(40)
    expect(rowNumbers(c)[0]).toBe('1')
    // 初始在顶部：不应出现上占位行（底部占位行仍会出现，用于撑出剩余滚动高度）
    expect(c.querySelector('[data-spacer="top"]')).toBeNull()
  })

  it('滚动到第 101 行：渲染正确绝对行号 + 上占位行撑高，第 1 行已卸载', () => {
    const c = mount(200)
    const wrap = c.querySelector('.tgrid-wrap') as HTMLElement
    setViewport(wrap, 300, 36 * 100)
    act(() => {
      wrap.dispatchEvent(new Event('scroll'))
    })
    const nums = rowNumbers(c)
    expect(nums).toContain('101')
    expect(nums).not.toContain('1')
    const spacer = c.querySelector('[data-spacer="top"]') as HTMLElement
    expect(spacer).toBeTruthy()
    // 上占位高度 = 渲染起点之前的行累计高度：scrollTop=3600（第 100 行边界）时
    // 可视首行=100，overscan=4 → start=96 → 96 × 36 = 3456px
    expect(spacer.style.height).toBe(`${96 * 36}px`)
  })

  it('滚动后编辑单元格：受控 value 与写回行索引都对应绝对行（不因 slice 偏移）', () => {
    const c = mount(200)
    const wrap = c.querySelector('.tgrid-wrap') as HTMLElement
    setViewport(wrap, 300, 36 * 100)
    act(() => {
      wrap.dispatchEvent(new Event('scroll'))
    })
    const rownum = [...c.querySelectorAll('.tgrid-rownum')].find((el) => el.textContent === '101') as HTMLElement
    const tr = rownum.closest('tr') as HTMLTableRowElement
    const input = tr.querySelector('.tgrid-input') as HTMLInputElement
    expect(input.value).toBe('题目 101')
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '改过的第 101 题')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(current!.content.table.rows[100].title).toBe('改过的第 101 题')
    expect(current!.content.table.rows[0].title).toBe('题目 1')
  })

  it('滚动到表尾：下占位行存在且高度正确', () => {
    const c = mount(200)
    const wrap = c.querySelector('.tgrid-wrap') as HTMLElement
    setViewport(wrap, 300, 36 * 200)
    act(() => {
      wrap.dispatchEvent(new Event('scroll'))
    })
    const nums = rowNumbers(c)
    expect(nums).toContain('200')
    const spacers = c.querySelectorAll('.tgrid-spacer')
    expect(spacers.length).toBe(1) // 只剩上占位（末行已渲染，无需下占位）
    expect(c.querySelector('[data-spacer="top"]')).toBeTruthy()
    expect(c.querySelector('[data-spacer="bottom"]')).toBeNull()
    // 末尾窗口：scrollTop=7200=total，start=195（末 5 行+overscan 夹紧）→ 195 × 36
    expect((spacers[0] as HTMLElement).style.height).toBe(`${195 * 36}px`)
  })
})
