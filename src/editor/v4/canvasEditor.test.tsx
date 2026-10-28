// @vitest-environment jsdom
/**
 * W13 共享画布测试（docs/57）：
 * - 两个画布「基本等同」：同一 testid 骨架、同一组件库面板、同一视图条/画布/检查器结构；
 * - fit 缩放纯函数（40%–150%，宽 0 回退 1）；
 * - 组件面板搜索过滤；
 * - 选中在 pointerup（避免拖拽中属性栏出现导致画布缩放）、Delete/Backspace 删除 + 输入框守卫；
 * - surface 视图过滤语义（未声明 view = 所有视图可见）。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it } from 'vitest'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import type { LevelDocV4 } from '../../engine/v4/model'
import { newResourceId } from '../../library/id'
import { computeCanvasFit } from './CanvasEditor'
import { ShellTab } from './ShellTab'
import { TypesTab } from './TypesTab'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Mounted {
  container: HTMLElement
  rerender: (ui: React.ReactElement) => void
  unmount: () => void
}

function mount(ui: React.ReactElement): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root!: Root
  act(() => {
    root = createRoot(container)
    root.render(ui)
  })
  return {
    container,
    rerender: (next: React.ReactElement) => {
      act(() => root.render(next))
    },
    unmount: () => {
      act(() => root.unmount())
      container.remove()
    },
  }
}

function byTestId(container: HTMLElement, testId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="${testId}"]`)
  if (!el) throw new Error(`找不到锚点 ${testId}`)
  return el as HTMLElement
}

function maybeTestId(container: HTMLElement, testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
}

const nativeInputValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!

function typeInput(input: HTMLInputElement, value: string): void {
  act(() => {
    nativeInputValue.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function click(el: Element): void {
  act(() => {
    ;(el as HTMLElement).click()
  })
}

function pointerSelect(el: Element): void {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11, clientX: 10, clientY: 10 }))
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 11 }))
  })
}

function sampleDoc(): LevelDocV4 {
  const doc = minimalLevelDoc()
  doc.id = newResourceId()
  return doc
}

function harness(
  Component: (props: {
    doc: LevelDocV4
    revision: number
    onChange: (next: LevelDocV4) => void
  }) => React.ReactElement,
) {
  let current = sampleDoc()
  const render = (): React.ReactElement => (
    <Component
      doc={current}
      revision={0}
      onChange={(next) => {
        current = next
      }}
    />
  )
  const mounted = mount(render())
  return {
    mounted,
    current: () => current,
    sync: () => mounted.rerender(render()),
  }
}

function paletteAddIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-testid^="v4-canvas-add-"]')]
    .map((el) => el.getAttribute('data-testid') ?? '')
    .sort()
}

describe('W13 画布 fit 缩放（纯函数）', () => {
  it('按宽度等比缩放，区间 40%–150%；宽 0/非法值回退 1（jsdom 首帧不抖动）', () => {
    expect(computeCanvasFit(0)).toBe(1)
    expect(computeCanvasFit(-10)).toBe(1)
    expect(computeCanvasFit(Number.NaN)).toBe(1)
    expect(computeCanvasFit(320)).toBe(0.4)
    expect(computeCanvasFit(400)).toBe(0.5)
    expect(computeCanvasFit(800)).toBe(1)
    expect(computeCanvasFit(1000)).toBe(1.25)
    expect(computeCanvasFit(1200)).toBe(1.5)
    expect(computeCanvasFit(1600)).toBe(1.5)
    // data-scale 首帧可见（jsdom 无布局 → 1）
    const harnessed = harness(ShellTab)
    try {
      expect(byTestId(harnessed.mounted.container, 'v4-canvas-stage').getAttribute('data-scale')).toBe('1')
    } finally {
      harnessed.mounted.unmount()
    }
  })
})

describe('W13 两个画布基本等同（同一 CanvasEditor）', () => {
  it('shell 画布与 surface 画布具有同一 testid 骨架、同一组件库按钮集合', () => {
    const shellHarness = harness(ShellTab)
    const surfaceHarness = harness(TypesTab)
    try {
      const shell = shellHarness.mounted.container
      const surface = surfaceHarness.mounted.container
      click(byTestId(surface, 'v4-type-subtab-surface'))

      for (const testId of [
        'v4-canvas',
        'v4-canvas-palette',
        'v4-canvas-search',
        'v4-canvas-items',
        'v4-canvas-views',
        'v4-canvas-view-add',
        'v4-canvas-viewport',
        'v4-canvas-stage',
        'v4-canvas-scale',
      ]) {
        expect(maybeTestId(shell, testId), `shell 画布缺少 ${testId}`).not.toBeNull()
        expect(maybeTestId(surface, testId), `surface 画布缺少 ${testId}`).not.toBeNull()
      }
      expect(byTestId(shell, 'v4-canvas').getAttribute('data-layer')).toBe('shell')
      expect(byTestId(surface, 'v4-canvas').getAttribute('data-layer')).toBe('surface')
      // 组件库面板按钮（类别/顺序/类型）完全一致
      expect(paletteAddIds(surface)).toEqual(paletteAddIds(shell))
      expect(paletteAddIds(shell).length).toBeGreaterThan(5)
      // 未选中时两个画布都不渲染属性检查器（选中才出现）
      expect(maybeTestId(shell, 'v4-canvas-inspector')).toBeNull()
      expect(maybeTestId(surface, 'v4-canvas-inspector')).toBeNull()
    } finally {
      shellHarness.mounted.unmount()
      surfaceHarness.mounted.unmount()
    }
  })

  it('组件面板搜索按显示名/类型过滤', () => {
    const shellHarness = harness(ShellTab)
    try {
      const container = shellHarness.mounted.container
      expect(maybeTestId(container, 'v4-canvas-add-label')).not.toBeNull()
      typeInput(byTestId(container, 'v4-canvas-search') as HTMLInputElement, '五线谱')
      expect(maybeTestId(container, 'v4-canvas-add-staff')).not.toBeNull()
      expect(maybeTestId(container, 'v4-canvas-add-label')).toBeNull()
      typeInput(byTestId(container, 'v4-canvas-search') as HTMLInputElement, '')
      expect(maybeTestId(container, 'v4-canvas-add-label')).not.toBeNull()
    } finally {
      shellHarness.mounted.unmount()
    }
  })
})

describe('W13 画布选区与快捷键', () => {
  it('点选在 pointerup 打开属性检查器；Delete 删除选中组件（tag=shell）', () => {
    const shellHarness = harness(ShellTab)
    try {
      const container = shellHarness.mounted.container
      expect(shellHarness.current().content.shell.components).toHaveLength(1)
      pointerSelect(byTestId(container, 'v4-canvas-box-scoreLabel'))
      shellHarness.sync()
      expect(byTestId(container, 'v4-canvas-inspector')).toBeTruthy()
      expect(byTestId(container, 'v4-canvas-box-scoreLabel').getAttribute('data-selected')).toBe('true')

      act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      })
      shellHarness.sync()
      expect(shellHarness.current().content.shell.components).toHaveLength(0)
      expect(maybeTestId(container, 'v4-canvas-inspector')).toBeNull()
      // 空视图提示接替
      expect(byTestId(container, 'v4-canvas-empty')).toBeTruthy()
    } finally {
      shellHarness.mounted.unmount()
    }
  })

  it('焦点在输入框时 Delete 放行给控件（不误删组件）', () => {
    const shellHarness = harness(ShellTab)
    try {
      const container = shellHarness.mounted.container
      pointerSelect(byTestId(container, 'v4-canvas-box-scoreLabel'))
      shellHarness.sync()
      const nameInput = byTestId(container, 'v4-canvas-name') as HTMLInputElement
      act(() => {
        nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
      })
      shellHarness.sync()
      expect(shellHarness.current().content.shell.components).toHaveLength(1)
    } finally {
      shellHarness.mounted.unmount()
    }
  })
})

describe('W13 surface 画布视图过滤', () => {
  it('未声明 view 的组件在所有视图可见；声明 view 的只在归属视图', () => {
    const doc = sampleDoc()
    const type = doc.content.types[0]
    type.surface.views = [
      { id: 'view1', name: '读题' },
      { id: 'view2', name: '作答' },
    ]
    type.surface.components[0].view = 'view1' // 题面只在读题视图
    let current = doc
    const render = (): React.ReactElement => (
      <TypesTab
        doc={current}
        onChange={(next) => {
          current = next
        }}
      />
    )
    const mounted = mount(render())
    try {
      click(byTestId(mounted.container, 'v4-type-subtab-surface'))
      expect(byTestId(mounted.container, 'v4-canvas-box-prompt')).toBeTruthy()
      expect(byTestId(mounted.container, 'v4-canvas-box-choice1')).toBeTruthy()
      // 切到作答视图：题面（view1）隐藏，常驻选项组件仍可见
      click(byTestId(mounted.container, 'v4-canvas-view-select-view2'))
      expect(maybeTestId(mounted.container, 'v4-canvas-box-prompt')).toBeNull()
      expect(byTestId(mounted.container, 'v4-canvas-box-choice1')).toBeTruthy()
    } finally {
      mounted.unmount()
    }
  })
})
