/**
 * v4 编辑器共享画布（W13，docs/57）：shell 画布 与 题型 surface 画布的唯一实现。
 *
 * 结构（v3 画布的能力回归 + v4 两层复用）：
 * - 左：组件面板——按 contract.category 分组的快捷添加列表 + 搜索 + 「本视图组件」清单；
 * - 中：视图条（重命名/设初始/删除/新增）+ 800×470 画布（按时宽自动 fit 缩放、
 *   拖拽移动/右下手柄缩放、10px 吸附、点击选中、Delete 删除）；
 * - 右：属性检查器（名称/可见/视图归属/X-Y-W-H/初始 props JSON/只读绑定/删除）。
 *
 * 写路径纪律：本组件不构造 LevelDocV4、不原地改组件；所有变更经 props 回调由
 * ShellTab / TypesTab 用 docStateV4 纯函数完成，最终走 EditorPageV4.update 单一入口。
 * 预览用独立 ComponentStore（`ComponentView` 真组件渲染），绑定按层根求值，
 * 不产生运行副作用（运行/调试画面在 PreviewTab）。
 *
 * 层差异全部经 props 注入（绑定根/预览环境/视图可见性/上限/视图删除语义），
 * 组件本身对 shell 与 surface 一视同仁——两个画布因此「基本等同」。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ComponentView } from '../../components/views'
import type { Json } from '../../engine/expr'
import { DATA_APPLY_COMMANDS, type ComponentInstance } from '../../engine/level'
import { checkV4Expr } from '../../engine/v4/expr'
import type { ComponentInstanceV4, ViewDefV4 } from '../../engine/v4/model'
import { STAGE_H, STAGE_W } from '../../runtime/stageGeometry'
import { ComponentStore, allContracts } from '../../runtime/store'
import { EDITOR_HOOKS } from '../editorHooks'
import { deleteTargetBlocked } from '../keyGuard'
import {
  applyBoundCommands,
  componentsInView,
  isObjectJson,
  mergeBoundProps,
  nextComponentLayout,
  type CanvasLayout,
} from './canvasPreview'
import { JsonEditModal, errText } from './shared'
import './v4-canvas.css'

/** 画布不传 layout 时的兜底框（与 docStateV4.defaultComponentLayout 无关，只用于显示） */
const FALLBACK_LAYOUT: CanvasLayout = { x: 0, y: 0, w: 120, h: 40 }

/** fit 缩放区间：窄窗保底可编辑，宽窗最多放大到 150%（运行时仍按 1:1 渲染） */
export const CANVAS_MIN_SCALE = 0.4
export const CANVAS_MAX_SCALE = 1.5

/**
 * 画布等比缩放：按可用宽度 fit（runtime 舞台同为宽度 fit，编辑器额外允许放大到 150%）。
 * 宽 0（jsdom/未布局）回退 1，保证拖拽测试与首帧不抖动。
 */
export function computeCanvasFit(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, width / STAGE_W))
}

const PALETTE_CATEGORIES: { key: 'music' | 'ui' | 'hidden'; label: string }[] = [
  { key: 'music', label: '音乐' },
  { key: 'ui', label: '交互' },
  { key: 'hidden', label: '隐形' },
]

const NOOP_EMIT = (): void => {}

export interface CanvasEditorProps {
  layer: 'shell' | 'surface'
  /** 画布标题（"shell 画布" / "题内画布 · 题型名"） */
  title: string
  subtitle?: string
  components: ComponentInstanceV4[]
  views: ViewDefV4[]
  initialView?: string
  componentsLimit: number
  viewsLimit: number
  /** 允许删除到剩几个视图：shell=1（至少保留一个），surface=0（可回到无视图） */
  minViews: number
  /** surface=true：组件未声明 view = 所有视图可见，检查器提供「全部视图（常驻）」 */
  allowAllViews: boolean
  bindingRoots: readonly string[]
  bindingHint: string
  previewEnv: Record<string, Json>
  /** 工具栏右侧附加（surface：预览数据行选择器；shell：无） */
  headerExtra?: React.ReactNode
  /** 新增组件：返回新组件 id；layout 由画布按当前视图格位计算 */
  onAddComponent: (type: string, viewId: string, layout: CanvasLayout) => string
  onUpdateComponent: (componentId: string, patch: Partial<ComponentInstanceV4>) => void
  onRemoveComponent: (componentId: string) => void
  /** 新增视图：返回新视图 id（宿主同步创建后立即返回，画布据此切到新视图） */
  onAddView: () => string
  onRenameView: (viewId: string, name: string) => void
  onRemoveView: (viewId: string) => void
  onSetInitialView: (viewId: string) => void
}

export function CanvasEditor(props: CanvasEditorProps): React.ReactElement {
  const { layer, components, views, bindingRoots, previewEnv } = props
  const contracts = useMemo(
    () => allContracts().map((contract) => ({ type: contract.type, label: contract.displayName, category: contract.category })),
    [],
  )
  const contractLabels = useMemo(() => new Map(contracts.map((entry) => [entry.type, entry.label])), [contracts])
  const labelOf = useCallback((type: string) => contractLabels.get(type) ?? type, [contractLabels])

  /** 初始视图：未显式声明时回落首个视图（两层同构） */
  const initialView = props.initialView ?? views[0]?.id ?? ''
  const [viewState, setViewState] = useState(() => views[0]?.id ?? '')
  const currentView = views.some((view) => view.id === viewState) ? viewState : (views[0]?.id ?? '')
  const currentViewName = views.find((view) => view.id === currentView)?.name ?? currentView

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [propsEdit, setPropsEdit] = useState<{ componentId: string; value: Json } | null>(null)

  const visibleComponents = useMemo(
    () => componentsInView(layer, components, currentView, initialView),
    [layer, components, currentView, initialView],
  )
  // 选中组件必须在当前视图可见（视图切换/删除后自动失效，检查器随之关闭）
  const selectedComp = visibleComponents.find((component) => component.id === selectedId) ?? null

  const guarded = useCallback((fn: () => void): void => {
    try {
      fn()
      setError('')
    } catch (err) {
      setError(errText(err))
    }
  }, [])

  // -------------------------------------------------------------------------
  // 预览：绑定合并进 props 后建独立 store（命令型槽位补发），拖拽中间帧不写 doc → 不重建
  // -------------------------------------------------------------------------
  const preview = useMemo(() => {
    const store = new ComponentStore()
    const specs = mergeBoundProps(components, previewEnv, bindingRoots)
    store.init(specs.map((spec) => ({ ...spec, visible: true })) as ComponentInstance[])
    applyBoundCommands(store, specs)
    return { store, byId: new Map(specs.map((spec) => [spec.id, spec])) }
  }, [components, previewEnv, bindingRoots])

  // -------------------------------------------------------------------------
  // fit 缩放：按视口宽度等比缩放；ResizeObserver + rAF 合并 + 等值短路（G11 纪律）
  // -------------------------------------------------------------------------
  const viewportRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    let raf = 0
    let last = -1
    const apply = (): void => {
      const next = computeCanvasFit(el.clientWidth)
      if (Math.abs(next - last) < 1e-4) return
      last = next
      setScale(next)
    }
    apply() // 首帧同步测量，避免缩放进场闪跳
    const schedule = (): void => {
      if (raf !== 0) return
      raf = requestAnimationFrame(() => {
        raf = 0
        apply()
      })
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [])

  // -------------------------------------------------------------------------
  // 画布拖拽 / 手柄缩放：指针坐标按 scale 换算回 800×470 设计坐标
  // -------------------------------------------------------------------------
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ id: string; grabX: number; grabY: number; scale: number } | null>(null)
  const resizeRef = useRef<{ id: string; startX: number; startY: number; width: number; height: number; scale: number } | null>(null)
  const [transient, setTransient] = useState<{ id: string; layout: CanvasLayout } | null>(null)
  const transientRef = useRef<{ id: string; layout: CanvasLayout } | null>(null)
  const setTransientBoth = useCallback((next: { id: string; layout: CanvasLayout } | null): void => {
    transientRef.current = next
    setTransient(next)
  }, [])

  const pointerScale = (): { scale: number; left: number; top: number } => {
    const rect = canvasRef.current?.getBoundingClientRect()
    const currentScale = rect && rect.width > 0 ? rect.width / STAGE_W : 1
    return { scale: currentScale, left: rect?.left ?? 0, top: rect?.top ?? 0 }
  }

  const startDrag = (event: React.PointerEvent<HTMLDivElement>, component: ComponentInstanceV4): void => {
    // 合成事件/非活跃 pointerId 下 setPointerCapture 抛 InvalidPointerId（与 GraphEditor 同款坑）
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // ignore
    }
    const { scale: pointerScaleValue, left, top } = pointerScale()
    const layout = component.layout ?? FALLBACK_LAYOUT
    dragRef.current = {
      id: component.id,
      grabX: (event.clientX - left) / pointerScaleValue - layout.x,
      grabY: (event.clientY - top) / pointerScaleValue - layout.y,
      scale: pointerScaleValue,
    }
  }

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>, component: ComponentInstanceV4): void => {
    const drag = dragRef.current
    if (!drag || drag.id !== component.id) return
    const rect = canvasRef.current?.getBoundingClientRect()
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    const base = transientRef.current?.id === component.id ? transientRef.current.layout : (component.layout ?? FALLBACK_LAYOUT)
    const snap = (value: number): number => Math.round(value / 10) * 10
    const designX = (event.clientX - left) / drag.scale
    const designY = (event.clientY - top) / drag.scale
    const x = clampNumber(snap(designX - drag.grabX), 0, Math.max(0, STAGE_W - base.w))
    const y = clampNumber(snap(designY - drag.grabY), 0, Math.max(0, STAGE_H - base.h))
    if (x !== base.x || y !== base.y) setTransientBoth({ id: component.id, layout: { ...base, x, y } })
  }

  const startResize = (event: React.PointerEvent<HTMLSpanElement>, component: ComponentInstanceV4): void => {
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // ignore
    }
    const rect = canvasRef.current?.getBoundingClientRect()
    resizeRef.current = {
      id: component.id,
      startX: event.clientX,
      startY: event.clientY,
      width: component.layout?.w ?? FALLBACK_LAYOUT.w,
      height: component.layout?.h ?? FALLBACK_LAYOUT.h,
      scale: rect && rect.width > 0 ? rect.width / STAGE_W : 1,
    }
  }

  const moveResize = (event: React.PointerEvent<HTMLSpanElement>, component: ComponentInstanceV4): void => {
    const resize = resizeRef.current
    if (!resize || resize.id !== component.id) return
    const layout = component.layout ?? FALLBACK_LAYOUT
    const width = clampNumber(
      Math.round((resize.width + (event.clientX - resize.startX) / resize.scale) / 2) * 2,
      40,
      STAGE_W,
    )
    const height = clampNumber(
      Math.round((resize.height + (event.clientY - resize.startY) / resize.scale) / 2) * 2,
      28,
      STAGE_H,
    )
    if (width !== layout.w || height !== layout.h) setTransientBoth({ id: component.id, layout: { ...layout, w: width, h: height } })
  }

  /** 指针落点：transient 有值才 commit 一次（拖拽/缩放共用），然后才选中（属性栏出现不打断拖拽） */
  const finishPointer = (componentId: string): void => {
    const current = transientRef.current
    dragRef.current = null
    resizeRef.current = null
    setTransientBoth(null)
    if (current) guarded(() => props.onUpdateComponent(current.id, { layout: current.layout }))
    setSelectedId(componentId)
  }

  // Delete/Backspace 删除选中（弹窗/输入框/按钮聚焦时放行给控件；与 v3 画布口径一致）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
      if (deleteTargetBlocked(event.target)) return
      const target = selectedComp
      if (!target) return
      event.preventDefault()
      guarded(() => props.onRemoveComponent(target.id))
      setSelectedId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedComp, guarded, props.onRemoveComponent])

  // -------------------------------------------------------------------------
  // 视图 / 组件操作（docState 抛错 → 画布内显示，不静默）
  // -------------------------------------------------------------------------
  const addComponent = (type: string): void => {
    guarded(() => {
      const layout = nextComponentLayout(visibleComponents.length)
      const id = props.onAddComponent(type, currentView, layout)
      setSelectedId(id)
    })
  }

  const addView = (): void => {
    guarded(() => {
      const id = props.onAddView()
      setViewState(id)
      setSelectedId(null)
    })
  }

  const removeView = (viewId: string): void => {
    guarded(() => {
      props.onRemoveView(viewId)
      if (viewId === currentView) setViewState(views.find((view) => view.id !== viewId)?.id ?? '')
      setSelectedId(null)
    })
  }

  const renameView = (viewId: string, name: string): void => {
    guarded(() => props.onRenameView(viewId, name))
  }

  const setInitialView = (viewId: string): void => {
    guarded(() => props.onSetInitialView(viewId))
  }

  const patchSelected = (patch: Partial<ComponentInstanceV4>): void => {
    const target = selectedComp
    if (!target) return
    guarded(() => props.onUpdateComponent(target.id, patch))
  }

  const setLayoutValue = (key: keyof CanvasLayout, raw: string): void => {
    const target = selectedComp
    if (!target || raw === '') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const layout = target.layout ?? FALLBACK_LAYOUT
    const next: CanvasLayout =
      key === 'w'
        ? { ...layout, w: clampNumber(Math.trunc(value), 1, STAGE_W) }
        : key === 'h'
          ? { ...layout, h: clampNumber(Math.trunc(value), 1, STAGE_H) }
          : { ...layout, [key]: Math.trunc(value) }
    guarded(() => props.onUpdateComponent(target.id, { layout: next }))
  }

  const applyPropsEdit = (value: Json): void => {
    if (!propsEdit) return
    const componentId = propsEdit.componentId
    guarded(() =>
      props.onUpdateComponent(componentId, {
        props: value === null ? undefined : isObjectJson(value) ? value : {},
      }),
    )
    setPropsEdit(null)
  }

  // 组件面板：搜索过滤（显示名/type 均匹配）
  const normalizedQuery = query.trim().toLowerCase()
  const paletteGroups = PALETTE_CATEGORIES.map((category) => ({
    ...category,
    items: contracts.filter(
      (entry) =>
        entry.category === category.key &&
        (normalizedQuery === '' ||
          entry.label.toLowerCase().includes(normalizedQuery) ||
          entry.type.toLowerCase().includes(normalizedQuery)),
    ),
  }))
  const hasPaletteResult = paletteGroups.some((group) => group.items.length > 0)

  return (
    <div className={`editor-canvas-layout v4-canvas-workbench`} data-testid="v4-canvas" data-layer={layer}>
      <aside className="palette v4-canvas-palette" data-testid="v4-canvas-palette">
        <b>组件面板（{layer === 'shell' ? 'shell 画布' : '题内画布'}）</b>
        <span className="muted">
          组件 {components.length}/{props.componentsLimit} · 本视图 {visibleComponents.length}
        </span>
        <input
          className="v4-canvas-search"
          placeholder="搜索组件"
          aria-label="搜索组件"
          value={query}
          data-testid="v4-canvas-search"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {paletteGroups.map((group) =>
          group.items.length === 0 ? null : (
            <div key={group.key} className="v4-canvas-palette-group">
              <div className="v4-canvas-palette-cat">{group.label}</div>
              {group.items.map((entry) => (
                <button
                  key={entry.type}
                  type="button"
                  data-testid={`v4-canvas-add-${entry.type}`}
                  disabled={components.length >= props.componentsLimit}
                  title={components.length >= props.componentsLimit ? `组件数已达上限 ${props.componentsLimit}` : `添加${entry.label}`}
                  onClick={() => addComponent(entry.type)}
                >
                  + {entry.label}
                </button>
              ))}
            </div>
          ),
        )}
        {!hasPaletteResult && <p className="muted v4-canvas-hint">没有匹配的组件。</p>}

        <div className="v4-canvas-items" data-testid="v4-canvas-items">
          <b>本视图组件（{visibleComponents.length}）</b>
          {visibleComponents.length === 0 && <p className="muted v4-canvas-hint">当前视图暂无组件。</p>}
          {visibleComponents.map((component) => (
            <button
              key={component.id}
              type="button"
              className={`v4-canvas-item${component.id === selectedId ? ' is-selected' : ''}`}
              data-testid={`v4-canvas-item-${component.id}`}
              title={`${component.type} · ${component.name ?? component.id}`}
              onClick={() => setSelectedId(component.id)}
            >
              {labelOf(component.type)} · {component.name ?? component.id}
            </button>
          ))}
        </div>

        {error !== '' && (
          <div className="tone-error" data-testid="v4-canvas-error">
            {error}
          </div>
        )}
        <p className="muted v4-canvas-hint">
          800×470 坐标系：拖拽移动、右下角手柄缩放；选中后在右侧编辑属性/绑定/视图归属。
          {layer === 'surface' ? '新增组件默认归入当前题内视图。' : ''}
        </p>
      </aside>

      <div className="v4-canvas-main">
        <div className="rules-toolbar v4-canvas-toolbar">
          <b>{props.title}</b>
          {props.subtitle !== undefined && <span className="muted">{props.subtitle}</span>}
          {props.headerExtra}
          <span className="muted v4-canvas-scale" data-testid="v4-canvas-scale" title="画布缩放（按可用宽度自动适应）">
            {Math.round(scale * 100)}%
          </span>
        </div>

        <div className="v4-canvas-views" data-testid="v4-canvas-views">
          {views.length === 0 && <span className="muted v4-canvas-hint">尚未声明题内视图——加视图后可按「读题 → 作答 → 反馈」分组；组件不选视图 = 所有视图可见。</span>}
          {views.map((view) => (
            <span
              key={view.id}
              className={`views-chip${view.id === currentView ? ' is-current' : ''}`}
              data-testid={`v4-canvas-view-${view.id}`}
            >
              <button
                type="button"
                className="views-open"
                data-testid={`v4-canvas-view-select-${view.id}`}
                title={`编辑视图 ${view.id}`}
                onClick={() => {
                  setViewState(view.id)
                  setSelectedId(null)
                }}
              >
                {view.id === currentView ? '▸ ' : ''}
                {view.name || view.id}
              </button>
              <input
                className="v4-canvas-view-name"
                value={view.name ?? ''}
                placeholder={view.id}
                maxLength={120}
                aria-label={`视图 ${view.id} 名称`}
                data-testid={`v4-canvas-view-name-${view.id}`}
                onChange={(event) => renameView(view.id, event.currentTarget.value)}
              />
              <button
                type="button"
                data-testid={`v4-canvas-view-initial-${view.id}`}
                disabled={initialView === view.id}
                title="进入该层时显示这个视图"
                onClick={() => setInitialView(view.id)}
              >
                {initialView === view.id ? '✓ 初始' : '设为初始'}
              </button>
              <button
                type="button"
                className="views-del"
                data-testid={`v4-canvas-view-remove-${view.id}`}
                disabled={views.length <= props.minViews}
                title={views.length <= props.minViews ? '至少保留一个视图' : '删除视图（shell 会一并删除其组件；surface 组件改为所有视图可见）'}
                onClick={() => removeView(view.id)}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            data-testid="v4-canvas-view-add"
            disabled={views.length >= props.viewsLimit}
            title={views.length >= props.viewsLimit ? `视图数已达上限 ${props.viewsLimit}` : '新增视图'}
            onClick={addView}
          >
            + 视图
          </button>
          <span className="muted v4-canvas-hint">当前「{currentViewName || '全部视图'}」</span>
        </div>

        <div className="v4-canvas-viewport" ref={viewportRef} data-testid="v4-canvas-viewport">
          <div className="v4-canvas-frame" style={{ width: STAGE_W * scale, height: STAGE_H * scale }}>
            <div
              ref={canvasRef}
              className={`${EDITOR_HOOKS.editorCanvas} v4-canvas-stage`}
              style={{ width: STAGE_W, height: STAGE_H, transform: `scale(${scale})` }}
              data-testid="v4-canvas-stage"
              data-scale={String(scale)}
              onPointerDown={() => setSelectedId(null)}
            >
              {visibleComponents.map((component) => {
                const transientLayout = transient?.id === component.id ? transient.layout : null
                const layout = transientLayout ?? component.layout ?? FALLBACK_LAYOUT
                const previewSpec = preview.byId.get(component.id) ?? component
                return (
                  <div
                    key={component.id}
                    className={`editor-box v4-canvas-box${selectedId === component.id ? ' is-selected' : ''}${component.visible === false ? ' is-ghost' : ''}`}
                    style={{ left: layout.x, top: layout.y, width: layout.w, height: layout.h }}
                    data-testid={`v4-canvas-box-${component.id}`}
                    data-comp-type={component.type}
                    data-selected={selectedId === component.id ? 'true' : 'false'}
                    title={`${component.type} · ${component.name ?? component.id}`}
                    onPointerDown={(event) => {
                      event.stopPropagation()
                      startDrag(event, component)
                    }}
                    onPointerMove={(event) => moveDrag(event, component)}
                    onPointerUp={() => finishPointer(component.id)}
                    onPointerCancel={() => finishPointer(component.id)}
                  >
                    <div className="editor-box-preview" inert={true as unknown as boolean}>
                      <ComponentView
                        spec={{ ...previewSpec, visible: true, layout: { ...layout, x: 0, y: 0 } }}
                        store={preview.store}
                        emit={NOOP_EMIT}
                      />
                    </div>
                    <span className="box-label">{component.name ?? component.id}</span>
                    <span
                      className="box-resize"
                      title="拖拽调整大小"
                      data-testid={`v4-canvas-resize-${component.id}`}
                      onPointerDown={(event) => startResize(event, component)}
                      onPointerMove={(event) => moveResize(event, component)}
                      onPointerUp={(event) => {
                        event.stopPropagation()
                        finishPointer(component.id)
                      }}
                      onPointerCancel={() => finishPointer(component.id)}
                    />
                  </div>
                )
              })}
              {visibleComponents.length === 0 && (
                <p className="muted v4-canvas-empty" data-testid="v4-canvas-empty">
                  当前视图没有组件——从左侧组件面板添加
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {selectedComp && (
        <aside className="inspector v4-canvas-inspector" data-testid="v4-canvas-inspector">
          <b>
            属性 · {labelOf(selectedComp.type)} <code>{selectedComp.id}</code>
          </b>
          <label>
            名称
            <input
              value={selectedComp.name ?? ''}
              maxLength={120}
              data-testid="v4-canvas-name"
              onChange={(event) => patchSelected({ name: event.currentTarget.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={selectedComp.visible !== false}
              data-testid="v4-canvas-visible"
              onChange={(event) => patchSelected({ visible: event.currentTarget.checked })}
            />{' '}
            可见
          </label>
          {views.length > 0 && (
            <label>
              所属视图
              <select
                value={props.allowAllViews ? (selectedComp.view ?? '') : (selectedComp.view ?? initialView)}
                data-testid="v4-canvas-view-field"
                onChange={(event) =>
                  patchSelected({ view: event.currentTarget.value === '' ? undefined : event.currentTarget.value })
                }
              >
                {props.allowAllViews && <option value="">全部视图（常驻）</option>}
                {views.map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.name || view.id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="inspector-layout" data-testid="v4-canvas-layout">
            {(['x', 'y', 'w', 'h'] as const).map((key) => (
              <label key={key}>
                {key.toUpperCase()}
                <input
                  type="number"
                  value={String((selectedComp.layout ?? FALLBACK_LAYOUT)[key])}
                  data-testid={`v4-canvas-layout-${key}`}
                  onChange={(event) => setLayoutValue(key, event.currentTarget.value)}
                />
              </label>
            ))}
          </div>

          <div className="v4-comp-props">
            <span>初始 props</span>
            <code className="v4-props-preview">
              {selectedComp.props === undefined ? '（未设置）' : JSON.stringify(selectedComp.props)}
            </code>
            <button
              type="button"
              data-testid="v4-canvas-props-edit"
              onClick={() => setPropsEdit({ componentId: selectedComp.id, value: selectedComp.props ?? null })}
            >
              编辑 JSON
            </button>
          </div>

          <BindingsEditor
            key={selectedComp.id}
            component={selectedComp}
            roots={bindingRoots}
            hint={props.bindingHint}
            onPatch={(patch) => patchSelected(patch)}
          />

          <button
            type="button"
            className="danger"
            data-testid="v4-canvas-remove"
            title="删除组件（Delete）"
            onClick={() => {
              guarded(() => props.onRemoveComponent(selectedComp.id))
              setSelectedId(null)
            }}
          >
            删除组件
          </button>
        </aside>
      )}

      {propsEdit && (
        <JsonEditModal
          title={`编辑组件初始 props · ${propsEdit.componentId}`}
          value={propsEdit.value}
          hint="props 为组件挂载时的初始状态；绑定（bindings）在画布预览/运行态按表达式覆盖对应槽位。必须是 JSON 对象（空文本 = 清空）。"
          testId="v4-canvas-props"
          onApply={applyPropsEdit}
          onClose={() => setPropsEdit(null)}
        />
      )}
    </div>
  )
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * 绑定行：槽位集合只来自 `DATA_APPLY_COMMANDS[type]`（与 runtime/lint 单一真源一致）；
 * 空表达式 = 删除该槽位；非空即写入文档并实时按层根校验。
 * 组件切换时由调用方 key={component.id} 重挂，避免待编辑槽位串到新组件。
 */
function BindingsEditor(props: {
  component: ComponentInstanceV4
  roots: readonly string[]
  hint: string
  onPatch: (patch: Partial<ComponentInstanceV4>) => void
}): React.ReactElement {
  const { component, roots } = props
  const slots = Object.keys(DATA_APPLY_COMMANDS[component.type] ?? {})
  const bindings = component.bindings ?? {}
  // 新增槽位先落到本地待编辑列表（空表达式 = 尚未绑定，不写入文档，避免空绑定进 lint）
  const [pendingSlots, setPendingSlots] = useState<string[]>([])
  const usedSlots = new Set([...Object.keys(bindings), ...pendingSlots])
  const freeSlots = slots.filter((slot) => !usedSlots.has(slot))
  const visibleSlots = [...Object.keys(bindings), ...pendingSlots.filter((slot) => !(slot in bindings))]

  const writeBinding = (slot: string, expr: string): void => {
    const next: Record<string, string> = {}
    for (const [key, value] of Object.entries(bindings)) {
      if (key === slot) continue
      if (value.trim() !== '') next[key] = value
    }
    if (expr.trim() !== '') next[slot] = expr
    props.onPatch({ bindings: Object.keys(next).length > 0 ? next : undefined })
  }

  return (
    <div className="v4-comp-bindings" data-testid="v4-canvas-bindings">
      <span>
        绑定（只读投影 · {slots.length === 0 ? '该组件类型不支持绑定' : `${props.hint}；槽位 ${slots.join(' / ')}`}）
      </span>
      {visibleSlots.map((slot) => {
        const expr = bindings[slot] ?? ''
        const checked = checkV4Expr(expr, { roots })
        return (
          <div key={slot} className="v4-binding-row">
            <code className="v4-binding-slot">{slot}</code>
            <input
              className="v4-binding-expr"
              value={expr}
              placeholder="只读表达式"
              aria-label={`绑定 ${slot} 表达式`}
              data-testid={`v4-canvas-binding-expr-${slot}`}
              onChange={(event) => writeBinding(slot, event.currentTarget.value)}
            />
            <button
              type="button"
              className="ginsp-argdel"
              title="移除绑定"
              data-testid={`v4-canvas-binding-remove-${slot}`}
              onClick={() => {
                writeBinding(slot, '')
                setPendingSlots((current) => current.filter((pending) => pending !== slot))
              }}
            >
              ×
            </button>
            {!checked.ok && (
              <div className="tone-error" data-testid={`v4-canvas-binding-error-${slot}`}>
                {checked.message}
              </div>
            )}
          </div>
        )
      })}
      {freeSlots.length > 0 && (
        <button
          type="button"
          data-testid="v4-canvas-binding-add"
          title="新增绑定槽位"
          onClick={() => setPendingSlots((current) => [...current, freeSlots[0]])}
        >
          + 绑定 {freeSlots[0]}
        </button>
      )}
    </div>
  )
}
