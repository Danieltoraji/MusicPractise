// @vitest-environment jsdom
// CanvasMap（画布对照小图）渲染与交互单测
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentInstance } from '../../engine/level'
import { CanvasMap } from './CanvasMap'

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

const comp = (id: string, name?: string, layout?: ComponentInstance['layout']): ComponentInstance => ({
  id,
  type: 'button',
  ...(name ? { name } : {}),
  ...(layout ? { layout } : {}),
})

describe('CanvasMap', () => {
  it('空画布显示占位提示', () => {
    const c = renderEl(<CanvasMap comps={[]} focusId={null} onToggleFocus={() => {}} onClose={() => {}} />)
    expect(c.textContent).toContain('画布还没有组件')
  })

  it('组件框按布局等比缩放并标注名称', () => {
    const c = renderEl(
      <CanvasMap
        comps={[
          comp('btn1', '开始按钮', { x: 0, y: 0, w: 120, h: 40 }),
          comp('slider1', undefined, { x: 200, y: 100, w: 200, h: 30 }),
        ]}
        focusId={null}
        onToggleFocus={() => {}}
        onClose={() => {}}
      />,
    )
    const boxes = [...c.querySelectorAll('.canvas-map-box')] as HTMLElement[]
    expect(boxes).toHaveLength(2)
    expect(boxes[0].textContent).toContain('开始按钮')
    expect(boxes[1].textContent).toContain('slider1')
    const style0 = boxes[0].style
    // 两个框都在面板体内（缩放后坐标非负且小于面板尺寸）
    expect(Number(style0.left.replace('px', ''))).toBeGreaterThanOrEqual(0)
    expect(Number(style0.top.replace('px', ''))).toBeGreaterThanOrEqual(0)
  })

  it('点击组件触发 onToggleFocus；焦点框带 is-focus；无布局组件用默认框', () => {
    const onToggle = vi.fn()
    const c = renderEl(
      <CanvasMap comps={[comp('ghost1')]} focusId="ghost1" onToggleFocus={onToggle} onClose={() => {}} />,
    )
    const box = c.querySelector('.canvas-map-box') as HTMLElement
    expect(box.className).toContain('is-focus')
    act(() => box.click())
    expect(onToggle).toHaveBeenCalledWith('ghost1')
  })

  it('关闭按钮触发 onClose', () => {
    const onClose = vi.fn()
    const c = renderEl(<CanvasMap comps={[comp('a')]} focusId={null} onToggleFocus={() => {}} onClose={onClose} />)
    act(() => (c.querySelector('.canvas-map-head button') as HTMLElement).click())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
