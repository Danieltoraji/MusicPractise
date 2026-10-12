// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { listEntriesFromCell, ListEditorModal } from './ListEditor'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('listEntriesFromCell（任意旧值 → 可编辑条目，永不失败）', () => {
  it('null/空 → []；数组逐项；非字符串 JSON 文本化；标量包装', () => {
    expect(listEntriesFromCell(null)).toEqual([])
    expect(listEntriesFromCell(undefined)).toEqual([])
    expect(listEntriesFromCell(['A', 'B'])).toEqual(['A', 'B'])
    expect(listEntriesFromCell([1, true, { k: 1 }])).toEqual(['1', 'true', '{"k":1}'])
    expect(listEntriesFromCell('C 大调')).toEqual(['C 大调'])
    expect(listEntriesFromCell(42)).toEqual(['42'])
    expect(listEntriesFromCell({ a: 1 })).toEqual(['{"a":1}'])
  })
})

describe('ListEditorModal（弹窗条目编辑）', () => {
  function mount(value: string[]): { c: HTMLElement; items: () => string[] | null; commit: () => void; restore: () => void } {
    let committed: string[] | null = null
    const container = document.createElement('div')
    document.body.appendChild(container)
    let root!: Root
    act(() => {
      root = createRoot(container)
      root.render(<ListEditorModal title="测试" value={value} onCommit={(items) => { committed = items }} onClose={() => {}} />)
    })
    return {
      c: container,
      items: () => committed,
      commit: () => {
        act(() => {
          ;[...container.querySelectorAll('button')].find((b) => b.textContent === '应用')!.click()
        })
      },
      restore: () => {
        act(() => root.unmount())
        container.remove()
      },
    }
  }

  function type(el: HTMLInputElement, value: string): void {
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('条目渲染 + 编辑 + 应用提交', () => {
    const h = mount(['C 大调', 'G 大调'])
    try {
      const rows = h.c.querySelectorAll('.tlist-row')
      expect(rows.length).toBe(2)
      type(rows[1].querySelector('input') as HTMLInputElement, 'D 大调')
      h.commit()
      expect(h.items()).toEqual(['C 大调', 'D 大调'])
    } finally {
      h.restore()
    }
  })

  it('添加/删除/上下移条目后提交', () => {
    const h = mount(['甲', '乙', '丙'])
    try {
      const btn = (text: string, scope?: HTMLElement): HTMLElement =>
        [...(scope ?? h.c).querySelectorAll('button')].find((b) => b.textContent === text)!
      // 删除「乙」（第 2 行的 ×）
      act(() => btn('×', h.c.querySelectorAll('.tlist-row')[1] as HTMLElement).click())
      expect(h.c.querySelectorAll('.tlist-row').length).toBe(2)
      // 「甲」下移 → [乙? no: 甲乙丙 minus 乙 = 甲,丙 → 甲下移 → 丙,甲]
      act(() => btn('↓', h.c.querySelectorAll('.tlist-row')[0] as HTMLElement).click())
      // 添加条目并输入
      act(() => btn('+ 添加条目').click())
      const inputs = h.c.querySelectorAll('.tlist-row input')
      expect(inputs.length).toBe(3)
      type(inputs[2] as HTMLInputElement, '丁')
      h.commit()
      expect(h.items()).toEqual(['丙', '甲', '丁'])
    } finally {
      h.restore()
    }
  })

  it('全部删空后提交 → 空数组（调用方决定落 null）', () => {
    const h = mount(['甲'])
    try {
      act(() => {
        ;(h.c.querySelector('.tlist-row .ginsp-argdel') as HTMLElement).click()
      })
      expect(h.c.textContent).toContain('还没有条目')
      h.commit()
      expect(h.items()).toEqual([])
    } finally {
      h.restore()
    }
  })
})
