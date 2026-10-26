/**
 * v4 编辑器「舞台」Tab（docs/53 §13.3 舞台；docs/52 W7.3）：
 * shell 视图管理 + 800×470 组件画布（选中/拖拽平移/右下角手柄缩放/数字布局精确编辑）
 * + 组件新增（组件库类型选择）/删除/属性（name/visible/视图归属/props JSON）
 * + 绑定编辑（槽位来自 `DATA_APPLY_COMMANDS[type]`，表达式实时 `checkV4Expr`，层根 `SHELL_BINDING_ROOTS`）。
 *
 * 写路径全部走 `docStateV4` 纯函数族（结构共享 + 程序化 id + 撤销 tag），本文件不直接构造
 * LevelDocV4、不原地修改组件；画布预览用独立的 ComponentStore（`ComponentView` 真组件渲染），
 * 与运行态会话无关（运行/调试画面在 PreviewTab）。
 *
 * 运行归属（docs/40 §12.4）：本 Tab 不持有会话/计时器，卸载无需额外清理。
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { ComponentView } from '../../components/views'
import type { Json } from '../../engine/expr'
import { DATA_APPLY_COMMANDS } from '../../engine/level'
import type { ComponentInstance } from '../../engine/level'
import { SHELL_BINDING_ROOTS, checkV4Expr, evalV4 } from '../../engine/v4/expr'
import {
  SCHEMA_LIMITS_V4,
  cloneJson,
  type ComponentInstanceV4,
  type LevelDocV4,
} from '../../engine/v4/model'
import { STAGE_H, STAGE_W } from '../../runtime/stageGeometry'
import { ComponentStore, allContracts } from '../../runtime/store'
import { EDITOR_HOOKS } from '../editorHooks'
import {
  SHELL_LAYER,
  addComponent,
  addView,
  removeComponent,
  removeView,
  updateComponent,
  updateShell,
  updateView,
} from './docStateV4'
import { JsonEditModal, errText, type V4EditorSlotProps } from './shared'
import './v4-preview.css'

/**
 * 舞台编辑的撤销 tag：连续舞台操作合并为一条撤销步（提示：视图改名与随后的组件拖动
 * 若中间没有其它 tag 也会合并——与 v3「同 tag 连续合并」语义一致）。
 */
const SHELL_TAG = 'shell'

const STAGE_HINT = '800 × 470 坐标系：拖拽组件移动，右下角手柄缩放；选中后可在右侧精确编辑'

const FALLBACK_LAYOUT = { x: 0, y: 0, w: 120, h: 40 }

type Layout = { x: number; y: number; w: number; h: number }

const noopEmit = (): void => {}

function isObjectJson(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 舞台预览环境：v = flow.vars 初值，run = 空题单（只读投影，不产生运行副作用） */
function previewEnv(doc: LevelDocV4): Record<string, Json> {
  const v: Record<string, Json> = {}
  for (const field of doc.content.flow.vars ?? []) v[field.key] = cloneJson(field.init)
  return { v, run: { questions: [], total: 0, seed: 0, index: 0 } }
}

/**
 * 组件的预览规格：绑定按 shell 层根（v/run）求值并合并进 props（同 runtime mountLayer 口径），
 * 求值失败时保留静态 props（非法表达式由实时校验/lint 提示，预览不中断）。
 */
function previewSpecs(doc: LevelDocV4, components: ComponentInstanceV4[]): ComponentInstanceV4[] {
  const env = previewEnv(doc)
  return components.map((component) => {
    if (!component.bindings) return component
    const props: Record<string, Json> = isObjectJson(component.props) ? { ...component.props } : {}
    for (const [slot, expr] of Object.entries(component.bindings)) {
      const mapping = DATA_APPLY_COMMANDS[component.type]?.[slot]
      if (!mapping) continue
      if (expr.trim() === '') continue
      try {
        props[mapping.argKey] = evalV4(expr, env, SHELL_BINDING_ROOTS)
      } catch {
        // 预览忽略非法绑定：编辑器 lint/实时校验负责提示
      }
    }
    return { ...component, props: props as Json }
  })
}

export function ShellTab({ doc, onChange, revision }: V4EditorSlotProps): React.ReactElement {
  const shell = doc.content.shell
  const views = shell.views
  const contractTypes = useMemo(
    () => allContracts().map((contract) => ({ type: contract.type, label: contract.displayName, category: contract.category })),
    [],
  )

  // 当前编辑视图：跨重渲染保留；视图被删/换文档时回落首视图
  const [view, setView] = useState(() => shell.views[0]?.id ?? 'main')
  const currentView = views.some((item) => item.id === view) ? view : (views[0]?.id ?? 'main')
  const initialView = shell.initialView ?? views[0]?.id ?? 'main'

  const [selected, setSelected] = useState<string | null>(null)
  const [newType, setNewType] = useState(() => contractTypes.find((item) => item.type === 'label')?.type ?? contractTypes[0]?.type ?? 'label')
  const [error, setError] = useState('')
  const [propsEdit, setPropsEdit] = useState<{ componentId: string; value: Json } | null>(null)

  const canvasRef = useRef<HTMLDivElement>(null)
  /** 拖拽/缩放中间帧只更新 transient（不写 doc、不入撤销栈），落点一次性 commit（docs/40 B2） */
  const [transient, setTransient] = useState<{ id: string; layout: Layout } | null>(null)
  const transientRef = useRef<{ id: string; layout: Layout } | null>(null)
  const setTransientBoth = useCallback((next: { id: string; layout: Layout } | null): void => {
    transientRef.current = next
    setTransient(next)
  }, [])
  const dragRef = useRef<{ id: string; grabX: number; grabY: number; cw: number; ch: number } | null>(null)
  const resizeRef = useRef<{ id: string; startX: number; startY: number; w: number; h: number } | null>(null)

  const selectedComp = shell.components.find((component) => component.id === selected) ?? null
  const viewComponents = shell.components.filter((component) => (component.view ?? initialView) === currentView)

  // 预览 store：签名变化（组件/绑定/props/vars 初值）才重建；拖拽中间帧不写 doc → 不重建
  const preview = useMemo(() => {
    const store = new ComponentStore()
    const specs = previewSpecs(doc, shell.components)
    store.init(specs.map((spec) => ({ ...spec, visible: true })) as ComponentInstance[])
    const byId = new Map(specs.map((spec) => [spec.id, spec]))
    return { store, byId }
  }, [doc, shell.components])

  const guarded = (fn: () => void): void => {
    try {
      fn()
      setError('')
    } catch (err) {
      setError(errText(err))
    }
  }

  // -------------------------------------------------------------------------
  // 视图管理
  // -------------------------------------------------------------------------

  const handleAddView = (): void => {
    guarded(() => {
      const result = addView(doc)
      onChange(result.doc, SHELL_TAG)
      setView(result.id)
      setSelected(null)
    })
  }

  const handleRemoveView = (viewId: string): void => {
    guarded(() => {
      const next = removeView(doc, viewId)
      if (next === doc) return
      onChange(next, SHELL_TAG)
      if (viewId === currentView) setView(next.content.shell.views[0]?.id ?? 'main')
      if (selected !== null && !next.content.shell.components.some((component) => component.id === selected)) {
        setSelected(null)
      }
    })
  }

  const handleRenameView = (viewId: string, name: string): void => {
    guarded(() => onChange(updateView(doc, viewId, { name }), SHELL_TAG))
  }

  const handleSetInitialView = (viewId: string): void => {
    guarded(() => onChange(updateShell(doc, (current) => ({ ...current, initialView: viewId })), SHELL_TAG))
  }

  // -------------------------------------------------------------------------
  // 组件新增 / 属性 / 删除
  // -------------------------------------------------------------------------

  const handleAddComponent = (): void => {
    guarded(() => {
      const result = addComponent(doc, SHELL_LAYER, newType)
      // addComponent 归属「初始视图」；编辑态归入当前视图更符合直觉
      const next = updateComponent(result.doc, SHELL_LAYER, result.id, { view: currentView })
      onChange(next, SHELL_TAG)
      setSelected(result.id)
    })
  }

  const patchSelected = (patch: Partial<ComponentInstanceV4>): void => {
    if (!selectedComp) return
    guarded(() => onChange(updateComponent(doc, SHELL_LAYER, selectedComp.id, patch), SHELL_TAG))
  }

  const handleRemoveSelected = (): void => {
    if (!selectedComp) return
    const componentId = selectedComp.id
    guarded(() => {
      onChange(removeComponent(doc, SHELL_LAYER, componentId), SHELL_TAG)
      setSelected(null)
    })
  }

  const setLayoutValue = (key: keyof Layout, raw: string): void => {
    if (raw === '') return
    const value = Number(raw)
    if (!Number.isFinite(value)) return
    const layout = selectedComp?.layout ?? FALLBACK_LAYOUT
    const next: Layout =
      key === 'w'
        ? { ...layout, w: clampNumber(Math.trunc(value), 1, STAGE_W) }
        : key === 'h'
          ? { ...layout, h: clampNumber(Math.trunc(value), 1, STAGE_H) }
          : { ...layout, [key]: Math.trunc(value) }
    patchSelected({ layout: next })
  }

  // -------------------------------------------------------------------------
  // 画布拖拽平移 / 手柄缩放（落点一次 commit）
  // -------------------------------------------------------------------------

  const startDrag = (e: React.PointerEvent<HTMLDivElement>, comp: ComponentInstanceV4): void => {
    // 合成事件/非活跃 pointerId 下 setPointerCapture 抛 InvalidPointerId（GraphEditor 同款坑）
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    setSelected(comp.id)
    const rect = canvasRef.current?.getBoundingClientRect()
    const layout = comp.layout ?? FALLBACK_LAYOUT
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    dragRef.current = {
      id: comp.id,
      grabX: e.clientX - left - layout.x,
      grabY: e.clientY - top - layout.y,
      // jsdom 无布局尺寸：宽高为 0 时回落 800×470（编辑器画布就是该坐标系）
      cw: rect && rect.width > 0 ? rect.width : STAGE_W,
      ch: rect && rect.height > 0 ? rect.height : STAGE_H,
    }
  }

  const moveDrag = (e: React.PointerEvent<HTMLDivElement>, comp: ComponentInstanceV4): void => {
    const drag = dragRef.current
    if (!drag || drag.id !== comp.id) return
    const base = transientRef.current?.id === comp.id ? transientRef.current.layout : (comp.layout ?? FALLBACK_LAYOUT)
    const rect = canvasRef.current?.getBoundingClientRect()
    const left = rect?.left ?? 0
    const top = rect?.top ?? 0
    const snap = (value: number): number => Math.round(value / 10) * 10
    const x = clampNumber(snap(e.clientX - left - drag.grabX), 0, Math.max(0, drag.cw - base.w))
    const y = clampNumber(snap(e.clientY - top - drag.grabY), 0, Math.max(0, drag.ch - base.h))
    if (x !== base.x || y !== base.y) setTransientBoth({ id: comp.id, layout: { ...base, x, y } })
  }

  const startResize = (e: React.PointerEvent<HTMLSpanElement>, comp: ComponentInstanceV4): void => {
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    setSelected(comp.id)
    resizeRef.current = {
      id: comp.id,
      startX: e.clientX,
      startY: e.clientY,
      w: comp.layout?.w ?? FALLBACK_LAYOUT.w,
      h: comp.layout?.h ?? FALLBACK_LAYOUT.h,
    }
  }

  const moveResize = (e: React.PointerEvent<HTMLSpanElement>, comp: ComponentInstanceV4): void => {
    const resize = resizeRef.current
    if (!resize || resize.id !== comp.id) return
    const layout = comp.layout ?? FALLBACK_LAYOUT
    const w = clampNumber(Math.round((resize.w + (e.clientX - resize.startX)) / 2) * 2, 40, STAGE_W)
    const h = clampNumber(Math.round((resize.h + (e.clientY - resize.startY)) / 2) * 2, 28, STAGE_H)
    if (w !== layout.w || h !== layout.h) setTransientBoth({ id: comp.id, layout: { ...layout, w, h } })
  }

  const commitTransient = useCallback((): void => {
    const current = transientRef.current
    dragRef.current = null
    resizeRef.current = null
    setTransientBoth(null)
    if (current) onChange(updateComponent(doc, SHELL_LAYER, current.id, { layout: current.layout }), SHELL_TAG)
  }, [doc, onChange, setTransientBoth])

  return (
    <div className="v4-shell-tab" data-testid="v4-shell-tab" data-revision={revision}>
      <aside className="palette v4-shell-palette" data-testid="v4-shell-palette">
        <b>组件面板（shell）</b>
        <span className="muted">
          常驻组件 {shell.components.length}/{SCHEMA_LIMITS_V4.shellComponents}
        </span>
        <select
          value={newType}
          data-testid="v4-shell-new-type"
          aria-label="选择组件类型"
          onChange={(e) => setNewType(e.target.value)}
        >
          {contractTypes.map((item) => (
            <option key={item.type} value={item.type}>
              {item.label}（{item.type}）
            </option>
          ))}
        </select>
        <button
          type="button"
          data-testid="v4-shell-add-component"
          disabled={shell.components.length >= SCHEMA_LIMITS_V4.shellComponents}
          onClick={handleAddComponent}
        >
          + 添加组件
        </button>
        {error && (
          <div className="tone-error" data-testid="v4-shell-error">
            {error}
          </div>
        )}
        <p className="muted v4-shell-hint">{STAGE_HINT}</p>
      </aside>

      <div className="v4-shell-main">
        <div className="rules-toolbar v4-shell-toolbar">
          <b>shell 舞台</b>
          <span className="muted">
            视图 {views.length}/{SCHEMA_LIMITS_V4.views} · 当前「{views.find((item) => item.id === currentView)?.name ?? currentView}」
          </span>
          <span className="muted">初始视图：{views.find((item) => item.id === initialView)?.name ?? initialView}</span>
        </div>

        <div className="v4-shell-views" data-testid="v4-shell-views">
          {views.map((item) => (
            <span
              key={item.id}
              className={`views-chip${item.id === currentView ? ' is-current' : ''}`}
              data-testid={`v4-shell-view-${item.id}`}
            >
              <button
                type="button"
                className="views-open"
                data-testid={`v4-shell-view-select-${item.id}`}
                title={`编辑视图 ${item.id}`}
                onClick={() => {
                  setView(item.id)
                  setSelected(null)
                }}
              >
                {item.id === currentView ? '▸ ' : ''}
                {item.name || item.id}
              </button>
              <input
                className="v4-shell-view-name"
                value={item.name ?? ''}
                placeholder={item.id}
                maxLength={120}
                aria-label={`视图 ${item.id} 名称`}
                data-testid={`v4-shell-view-name-${item.id}`}
                onChange={(e) => handleRenameView(item.id, e.currentTarget.value)}
              />
              <button
                type="button"
                data-testid={`v4-shell-view-initial-${item.id}`}
                disabled={item.id === initialView}
                title="设为初始视图（进入关卡时显示）"
                onClick={() => handleSetInitialView(item.id)}
              >
                设为初始
              </button>
              <button
                type="button"
                className="views-del"
                data-testid={`v4-shell-view-remove-${item.id}`}
                disabled={views.length <= 1}
                title="删除视图（其组件一并移除；至少保留一个视图）"
                onClick={() => handleRemoveView(item.id)}
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            data-testid="v4-shell-view-add"
            disabled={views.length >= SCHEMA_LIMITS_V4.views}
            onClick={handleAddView}
          >
            + 视图
          </button>
        </div>

        <div className="v4-shell-viewport">
          <div
            ref={canvasRef}
            className={`${EDITOR_HOOKS.editorCanvas} v4-shell-canvas`}
            style={{ width: STAGE_W, height: STAGE_H }}
            data-testid="v4-shell-canvas"
            onPointerDown={() => setSelected(null)}
          >
            {viewComponents.map((component) => {
              const transientLayout = transient?.id === component.id ? transient.layout : null
              const layout = transientLayout ?? component.layout
              const previewSpec = preview.byId.get(component.id) ?? component
              return (
                <div
                  key={component.id}
                  className={`editor-box v4-shell-box${selected === component.id ? ' is-selected' : ''}${component.visible === false ? ' is-ghost' : ''}`}
                  style={layout ? { left: layout.x, top: layout.y, width: layout.w, height: layout.h } : undefined}
                  data-testid={`v4-shell-component-${component.id}`}
                  data-comp-type={component.type}
                  data-selected={selected === component.id ? 'true' : 'false'}
                  title={`${component.type} · ${component.name ?? component.id}`}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    startDrag(e, component)
                  }}
                  onPointerMove={(e) => moveDrag(e, component)}
                  onPointerUp={commitTransient}
                  onPointerCancel={commitTransient}
                >
                  <div className="editor-box-preview" inert={true as unknown as boolean}>
                    <ComponentView
                      spec={{
                        ...previewSpec,
                        visible: true,
                        layout: layout ? { ...layout, x: 0, y: 0 } : undefined,
                      }}
                      store={preview.store}
                      emit={noopEmit}
                    />
                  </div>
                  <span className="box-label">{component.name ?? component.id}</span>
                  <span
                    className="box-resize"
                    title="拖拽调整大小"
                    data-testid={`v4-shell-resize-${component.id}`}
                    onPointerDown={(e) => startResize(e, component)}
                    onPointerMove={(e) => moveResize(e, component)}
                    onPointerUp={commitTransient}
                    onPointerCancel={commitTransient}
                  />
                </div>
              )
            })}
            {viewComponents.length === 0 && (
              <p className="muted v4-shell-empty-hint" data-testid="v4-shell-empty">
                当前视图没有组件——从左侧组件面板添加
              </p>
            )}
          </div>
        </div>
      </div>

      {selectedComp && (
        <aside className="inspector v4-shell-inspector" data-testid="v4-shell-inspector">
          <b>
            属性 · {selectedComp.type} <code>{selectedComp.id}</code>
          </b>
          <label>
            名称
            <input
              value={selectedComp.name ?? ''}
              maxLength={120}
              data-testid={`v4-shell-name-${selectedComp.id}`}
              onChange={(e) => patchSelected({ name: e.currentTarget.value })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={selectedComp.visible !== false}
              data-testid={`v4-shell-visible-${selectedComp.id}`}
              onChange={(e) => patchSelected({ visible: e.currentTarget.checked })}
            />{' '}
            可见
          </label>
          <label>
            所属视图
            <select
              value={selectedComp.view ?? initialView}
              data-testid={`v4-shell-view-field-${selectedComp.id}`}
              onChange={(e) => patchSelected({ view: e.currentTarget.value })}
            >
              {views.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
          </label>
          <div className="inspector-layout" data-testid={`v4-shell-layout-${selectedComp.id}`}>
            {(['x', 'y', 'w', 'h'] as const).map((key) => (
              <label key={key}>
                {key.toUpperCase()}
                <input
                  type="number"
                  value={String((selectedComp.layout ?? FALLBACK_LAYOUT)[key])}
                  data-testid={`v4-shell-layout-${key}-${selectedComp.id}`}
                  onChange={(e) => setLayoutValue(key, e.currentTarget.value)}
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
              data-testid={`v4-shell-props-edit-${selectedComp.id}`}
              onClick={() => setPropsEdit({ componentId: selectedComp.id, value: selectedComp.props ?? null })}
            >
              编辑 JSON
            </button>
          </div>

          <BindingsEditor component={selectedComp} onPatch={(patch) => patchSelected(patch)} />

          <button
            type="button"
            className="danger"
            data-testid={`v4-shell-remove-${selectedComp.id}`}
            onClick={handleRemoveSelected}
            title="删除组件"
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
          testId="v4-shell-props"
          onApply={(value) => {
            const props = value === null ? undefined : isObjectJson(value) ? value : {}
            patchSelected({ props })
            setPropsEdit(null)
          }}
          onClose={() => setPropsEdit(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 绑定编辑器（shell 层：槽位 = DATA_APPLY_COMMANDS[type] 键；根 = v/run）
// ---------------------------------------------------------------------------

/**
 * 绑定行：空表达式 = 删除该槽位；非空即写入文档并实时校验并显示错误。
 * 槽位集合只来自 `DATA_APPLY_COMMANDS[type]`（与 runtime/lint 单一真源一致），
 * 不支持绑定的组件类型给出说明（v4.0 仅 label/choice/staff 可绑定）。
 */
function BindingsEditor(props: {
  component: ComponentInstanceV4
  onPatch: (patch: Partial<ComponentInstanceV4>) => void
}): React.ReactElement {
  const { component } = props
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
    <div className="v4-comp-bindings" data-testid={`v4-shell-bindings-${component.id}`}>
      <span>
        绑定（只读投影 ·{' '}
        {slots.length === 0 ? '该组件类型不支持绑定' : `槽位 ${slots.join(' / ')} · 可用 v / run`}）
      </span>
      {visibleSlots.map((slot) => {
        const expr = bindings[slot] ?? ''
        const checked = checkV4Expr(expr, { roots: SHELL_BINDING_ROOTS })
        return (
          <div key={slot} className="v4-binding-row">
            <code className="v4-binding-slot">{slot}</code>
            <input
              className="v4-binding-expr"
              value={expr}
              placeholder="只读表达式，如 v.score"
              aria-label={`绑定 ${slot} 表达式`}
              data-testid={`v4-shell-binding-expr-${component.id}-${slot}`}
              onChange={(e) => writeBinding(slot, e.currentTarget.value)}
            />
            <button
              type="button"
              className="ginsp-argdel"
              title="移除绑定"
              data-testid={`v4-shell-binding-remove-${component.id}-${slot}`}
              onClick={() => {
                writeBinding(slot, '')
                setPendingSlots((current) => current.filter((pending) => pending !== slot))
              }}
            >
              ×
            </button>
            {!checked.ok && (
              <div className="tone-error" data-testid={`v4-shell-binding-error-${component.id}-${slot}`}>
                {checked.message}
              </div>
            )}
          </div>
        )
      })}
      {freeSlots.length > 0 && (
        <button
          type="button"
          data-testid={`v4-shell-binding-add-${component.id}`}
          title="新增绑定槽位"
          onClick={() => setPendingSlots((current) => [...current, freeSlots[0]])}
        >
          + 绑定 {freeSlots[0]}
        </button>
      )}
    </div>
  )
}
