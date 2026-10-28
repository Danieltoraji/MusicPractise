import { describe, expect, it } from 'vitest'
import { SURFACE_BINDING_ROOTS } from '../../engine/v4/expr'
import { minimalLevelDoc } from '../../engine/v4/fixtures'
import { ComponentStore } from '../../runtime/store'
import {
  CANVAS_LAYOUT,
  applyBoundCommands,
  buildShellPreviewEnv,
  buildSurfacePreviewEnv,
  componentsInView,
  emptyRunStub,
  mergeBoundProps,
  nextComponentLayout,
} from './canvasPreview'

describe('canvasPreview：绑定求值环境（shell / surface）', () => {
  it('shell：v = flow.vars 初值，run = 空题单投影', () => {
    const env = buildShellPreviewEnv(minimalLevelDoc())
    expect(env.v).toEqual({ score: 0 })
    expect(env.run).toEqual(emptyRunStub())
    expect(env.q).toBeUndefined()
  })

  it('surface：q = 预览行内容（排除元数据、补 id）+ q.state；t/args/v/run 齐全', () => {
    const doc = minimalLevelDoc()
    const type = doc.content.types[0]
    const env = buildSurfacePreviewEnv(doc, type, doc.content.tables.choice.rows[0])
    expect(env.q).toEqual({
      prompt: '听一听，这是什么音？',
      options: ['Do', 'Re', 'Mi'],
      scoring: 10,
      id: 'row_01',
      state: { answered: false },
    })
    expect(env.t).toEqual({ asked: 0 })
    expect(env.args).toEqual({ difficulty: 1 })
    expect(env.v).toEqual({ score: 0 })
    expect(env.run).toEqual(emptyRunStub())
    // 无预览行：q 只有 id 与 state 初值（绑定 q.prompt 求值失败会保留静态 props）
    expect(buildSurfacePreviewEnv(doc, type, null).q).toEqual({ id: '', state: { answered: false } })
  })

  it('mergeBoundProps：表达式覆盖对应槽位；非法表达式保留静态 props', () => {
    const components = [
      {
        id: 'label_1',
        type: 'label',
        layout: { x: 0, y: 0, w: 100, h: 40 },
        props: { text: '静态' },
        bindings: { text: 'q.prompt' },
      },
      {
        id: 'label_2',
        type: 'label',
        layout: { x: 0, y: 0, w: 100, h: 40 },
        props: { text: '保留' },
        bindings: { text: 'v.' },
      },
    ]
    const merged = mergeBoundProps(
      components,
      { q: { prompt: '题面' } },
      SURFACE_BINDING_ROOTS,
    )
    expect(merged[0].props).toEqual({ text: '题面' })
    expect(merged[1].props).toEqual({ text: '保留' })
    // 无绑定组件原样返回（引用复用）
    const plain = { id: 'label_3', type: 'label' }
    expect(mergeBoundProps([plain], {}, SURFACE_BINDING_ROOTS)[0]).toBe(plain)
  })

  it('applyBoundCommands：命令型槽位（choice.options）在 init 后补发，预览不再是空白', () => {
    const components = mergeBoundProps(
      [
        {
          id: 'choice_1',
          type: 'choice',
          layout: { x: 0, y: 0, w: 200, h: 100 },
          bindings: { options: 'q.options' },
        },
      ],
      { q: { options: ['Do', 'Re'] } },
      SURFACE_BINDING_ROOTS,
    )
    const store = new ComponentStore()
    store.init(components.map((component) => ({ ...component, visible: true })))
    applyBoundCommands(store, components)
    expect((store.snapshot('choice_1').state as { options: string[] }).options).toEqual(['Do', 'Re'])
  })
})

describe('canvasPreview：视图过滤（两层）', () => {
  const shellComponents = [
    { id: 'shell_main', type: 'label', view: 'main' },
    { id: 'shell_view2', type: 'label', view: 'view2' },
  ]
  const surfaceComponents = [
    { id: 'surface_all', type: 'label' },
    { id: 'surface_view2', type: 'label', view: 'view2' },
  ]

  it('shell：按归属视图过滤，缺省 view 回退初始视图', () => {
    expect(componentsInView('shell', shellComponents, 'main', 'main').map((c) => c.id)).toEqual(['shell_main'])
    expect(componentsInView('shell', shellComponents, 'view2', 'main').map((c) => c.id)).toEqual(['shell_view2'])
    // 缺省 view 的组件归入初始视图（不隐藏组件）
    expect(componentsInView('shell', [{ id: 'legacy', type: 'label' }], 'main', 'main').map((c) => c.id)).toEqual([
      'legacy',
    ])
  })

  it('surface：未声明 view 的组件在所有视图可见；声明了 view 的只在归属视图', () => {
    expect(componentsInView('surface', surfaceComponents, 'view2', 'view2').map((c) => c.id)).toEqual([
      'surface_all',
      'surface_view2',
    ])
    // 无视图（viewId='')：常驻组件仍可见，带 view 的组件不渲染
    expect(componentsInView('surface', surfaceComponents, '', '').map((c) => c.id)).toEqual(['surface_all'])
  })
})

describe('canvasPreview：新增组件默认格位', () => {
  it('按 3×3 格位循环，全部落在 800×470 画布内', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 40; i += 1) {
      const layout = nextComponentLayout(i)
      expect(layout.x).toBeGreaterThanOrEqual(0)
      expect(layout.y).toBeGreaterThanOrEqual(0)
      expect(layout.x + layout.w).toBeLessThanOrEqual(800)
      expect(layout.y + layout.h).toBeLessThanOrEqual(470)
      if (i < CANVAS_LAYOUT.cols * CANVAS_LAYOUT.rows) seen.add(`${layout.x}:${layout.y}`)
    }
    expect(seen.size).toBe(CANVAS_LAYOUT.cols * CANVAS_LAYOUT.rows)
    expect(nextComponentLayout(-1)).toEqual(nextComponentLayout(0))
    expect(nextComponentLayout(Number.NaN)).toEqual(nextComponentLayout(0))
  })
})
