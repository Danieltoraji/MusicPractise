/**
 * v4 编辑器画布预览纯函数（W13，docs/57）：
 * 把 runtime 里 mountLayer / mountSurface 的只读投影口径抽成编辑器可复用的纯函数——
 * - shell / surface 两层的绑定求值环境（v/run 与 q/q.state/t/args/v/run）；
 * - 绑定 → props 合并 + 命令型槽位（choice.options / staff.music）补发；
 * - 当前视图的组件过滤（shell 按归属视图；surface 未声明 view = 所有视图可见）；
 * - 新增组件的默认格位（保证落在 800×470 内，避免组件多了默认坐标越界）。
 *
 * 纪律：本文件不碰 React/DOM；表达式求值失败静默保留静态 props（实时错误由检查器
 * `checkV4Expr` 显示），与重构前的 ShellTab 预览口径一致。共享初值/行投影来自
 * `engine/v4/model`（session 与编辑器同一实现，避免口径漂移）。
 */
import type { Json } from '../../engine/expr'
import { DATA_APPLY_COMMANDS } from '../../engine/level'
import { evalV4 } from '../../engine/v4/expr'
import {
  cloneJson,
  initStateObject,
  questionContentOfRow,
  type ComponentInstanceV4,
  type LevelDocV4,
  type ParamFieldDef,
  type QuestionRow,
  type QuestionTypeDef,
} from '../../engine/v4/model'
import type { ComponentStore } from '../../runtime/store'

/** 画布设计坐标系（与运行时舞台一致；编辑器按宽度等比缩放） */
export const CANVAS_LAYOUT = {
  cols: 3,
  x0: 40,
  y0: 40,
  dx: 240,
  dy: 120,
  w: 200,
  h: 60,
  /** 纵向 3 行格位，保证默认新组件 y+h ≤ 470 */
  rows: 3,
} as const

export interface CanvasLayout {
  x: number
  y: number
  w: number
  h: number
}

/** 画布预览的 run 投影：无运行副作用（与 ref 版 ShellTab 完全一致的空题单） */
export function emptyRunStub(): Record<string, Json> {
  return { questions: [], total: 0, seed: 0, index: 0 }
}

export function isObjectJson(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** shell 层预览环境：v = flow.vars 初值；run = 空题单投影 */
export function buildShellPreviewEnv(doc: LevelDocV4): Record<string, Json> {
  return { v: initStateObject(doc.content.flow.vars), run: emptyRunStub() }
}

/** 题型参数默认值（编辑器预览用；运行态由题单 args 覆盖） */
function argDefaults(args: ParamFieldDef[] | undefined): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const field of args ?? []) out[field.key] = cloneJson(field.default ?? null)
  return out
}

/**
 * surface 层预览环境：q = 预览行内容投影 + q.state 初值；t/args 取题型 schema；
 * v = flow.vars 初值；run = 空题单投影。无预览行时 q 只有 id 与 state。
 */
export function buildSurfacePreviewEnv(
  doc: LevelDocV4,
  type: QuestionTypeDef,
  row: QuestionRow | null,
): Record<string, Json> {
  const qContent = row ? questionContentOfRow(row) : { id: '' }
  return {
    q: { ...qContent, state: initStateObject(type.state) },
    t: initStateObject(type.typeState),
    args: argDefaults(type.args),
    v: initStateObject(doc.content.flow.vars),
    run: emptyRunStub(),
  }
}

/** 当前编辑视图下可见的组件（shell：按归属视图；surface：缺省 view 常驻所有视图） */
export function componentsInView(
  layer: 'shell' | 'surface',
  components: ComponentInstanceV4[],
  viewId: string,
  initialView: string,
): ComponentInstanceV4[] {
  if (layer === 'shell') return components.filter((component) => (component.view ?? initialView) === viewId)
  return components.filter((component) => component.view === undefined || component.view === viewId)
}

/**
 * 绑定 → props 合并（同 runtime mountLayer）：只读表达式按层根求值并覆盖对应槽位；
 * 求值失败保留静态 props，不中断预览。
 */
export function mergeBoundProps(
  components: ComponentInstanceV4[],
  env: Record<string, Json>,
  roots: readonly string[],
): ComponentInstanceV4[] {
  return components.map((component) => {
    if (!component.bindings) return component
    const props: Record<string, Json> = isObjectJson(component.props) ? { ...component.props } : {}
    for (const [slot, expr] of Object.entries(component.bindings)) {
      const mapping = DATA_APPLY_COMMANDS[component.type]?.[slot]
      if (!mapping || expr.trim() === '') continue
      try {
        props[mapping.argKey] = evalV4(expr, env, roots)
      } catch {
        // 预览忽略非法绑定：编辑器检查器/lint 负责提示
      }
    }
    return { ...component, props: props as Json }
  })
}

/**
 * 命令型槽位补发（同 runtime mountLayer 的「init 后补发」）：choice.options / staff.music
 * 这类不消费 props 的组件，预览必须再走一次命令才不是空白。
 */
export function applyBoundCommands(store: ComponentStore, components: ComponentInstanceV4[]): void {
  for (const component of components) {
    if (!component.bindings) continue
    const props = isObjectJson(component.props) ? component.props : {}
    for (const slot of Object.keys(component.bindings)) {
      const mapping = DATA_APPLY_COMMANDS[component.type]?.[slot]
      if (!mapping) continue
      const value = props[mapping.argKey]
      if (value === undefined) continue
      try {
        store.applyCommand(component.id, mapping.method, { [mapping.argKey]: value })
      } catch {
        // 预览不因单槽位命令失败中断
      }
    }
  }
}

/**
 * 新增组件的默认格位：按当前视图内已有组件数在 3×3 格位上循环（落在 800×470 内）。
 * 组件超过 9 个后允许重叠——与旧行为一致，但不会再把新组件放到画布外。
 */
export function nextComponentLayout(countInView: number): CanvasLayout {
  const index = Number.isFinite(countInView) ? Math.max(0, Math.trunc(countInView)) : 0
  const col = index % CANVAS_LAYOUT.cols
  const row = Math.floor(index / CANVAS_LAYOUT.cols) % CANVAS_LAYOUT.rows
  return {
    x: CANVAS_LAYOUT.x0 + col * CANVAS_LAYOUT.dx,
    y: CANVAS_LAYOUT.y0 + row * CANVAS_LAYOUT.dy,
    w: CANVAS_LAYOUT.w,
    h: CANVAS_LAYOUT.h,
  }
}
