// 数据表字段选择器（docs/26）：解析/序列化纯函数 + 组件交互
// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { columnRefToExpr, exprToColumnRef, TableFieldPicker } from './TableFieldPicker'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []
const containers: HTMLElement[] = []

function renderEl(ui: React.ReactElement): HTMLElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  roots.push(root)
  containers.push(container)
  return container
}

afterEach(() => {
  roots.splice(0).forEach((r) => act(() => r.unmount()))
  containers.splice(0).forEach((c) => c.remove())
})

const COLUMNS = [
  { key: 'title', label: '标题', type: 'text' as const },
  { key: 'options', type: 'list' as const },
  { key: 'music', type: 'json' as const },
]

describe('exprToColumnRef / columnRefToExpr', () => {
  it('裸 q.<列> 引用识别（列存在时）；其余回落 null', () => {
    expect(exprToColumnRef('q.title', ['title', 'options'])).toBe('title')
    expect(exprToColumnRef(' q.title ', ['title'])).toBe('title')
    expect(exprToColumnRef('q.title', ['other'])).toBeNull() // 列不存在
    expect(exprToColumnRef('q.data.music', ['title'])).toBeNull() // 多段路径不是单列引用
    expect(exprToColumnRef('q.data', ['data'])).toBe('data')
    expect(exprToColumnRef('v.score', ['title'])).toBeNull()
    expect(exprToColumnRef('1 + 1', ['title'])).toBeNull()
    expect(columnRefToExpr('title')).toBe('q.title')
  })
})

describe('TableFieldPicker', () => {
  it('列引用值渲染为下拉并选中；选择列提交 q.<key>', () => {
    const onChange = vi.fn()
    const c = renderEl(
      <TableFieldPicker value="q.title" columns={COLUMNS} onChange={onChange} />,
    )
    const select = c.querySelector('select')!
    expect((select as HTMLSelectElement).value).toBe('title')
    act(() => {
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    // 模拟 select 改值：直接用原生 setter 触发 React onChange
    const setVal = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    act(() => {
      setVal.call(select, 'options')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('q.options')
  })

  it('空值显示占位选项；选项文本带类型徽标', () => {
    const c = renderEl(<TableFieldPicker value="" columns={COLUMNS} onChange={() => {}} />)
    const select = c.querySelector('select') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(select.textContent).toContain('文本列表')
    expect(select.textContent).toContain('标题（title）')
  })

  it('非列引用的非空值进高级输入（原文保留）；可切回列选择', () => {
    const onChange = vi.fn()
    const c = renderEl(
      <TableFieldPicker value="upper(q.title)" columns={COLUMNS} onChange={onChange} datalistId="dl" />,
    )
    expect(c.querySelector('select')).toBeNull()
    const input = c.querySelector('input') as HTMLInputElement
    expect(input.defaultValue).toBe('upper(q.title)')
    // 切回列选择
    act(() => {
      ;(c.querySelector('button') as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(c.querySelector('select')).not.toBeNull()
  })

  it('列类型不符时内联提示（setMusic ← 文本列）', () => {
    const c = renderEl(
      <TableFieldPicker
        value="q.title"
        columns={COLUMNS}
        accepted={{ accept: ['json'], hint: '五线谱需要 JSON 列（存乐谱对象 MusicDoc）' }}
        onChange={() => {}}
      />,
    )
    expect(c.querySelector('.tfp-warn')?.textContent).toContain('五线谱需要 JSON 列')
  })

  it('数据表没有列时直接高级输入', () => {
    const c = renderEl(<TableFieldPicker value="" columns={[]} onChange={() => {}} />)
    expect(c.querySelector('select')).toBeNull()
    expect(c.querySelector('input')).not.toBeNull()
  })
})
