/**
 * 组件状态仓库：逻辑引擎的命令经由这里落到具体组件实例的状态上，
 * React 视图通过 useSyncExternalStore 订阅。
 */
import type { ComponentInstance } from '../engine/level'
import type { Json } from '../engine/expr'
import {
  BUTTON_DEF,
  CHOICE_DEF,
  FINGERING_DEF,
  INPUT_DEF,
  LABEL_DEF,
  SLIDER_DEF,
  SOUND_DEF,
  STAFF_DEF,
  TIMER_DEF,
  type ComponentDef,
  type Effect,
} from './componentDef'

const DEFS: Record<string, ComponentDef<never>> = {
  label: LABEL_DEF as ComponentDef<never>,
  button: BUTTON_DEF as ComponentDef<never>,
  choice: CHOICE_DEF as ComponentDef<never>,
  staff: STAFF_DEF as ComponentDef<never>,
  sound: SOUND_DEF as ComponentDef<never>,
  timer: TIMER_DEF as ComponentDef<never>,
  slider: SLIDER_DEF as ComponentDef<never>,
  input: INPUT_DEF as ComponentDef<never>,
  fingering: FINGERING_DEF as ComponentDef<never>,
}

/** 未知组件类型的占位 def：状态/命令全部 no-op，视图层渲染"组件缺失"占位框 */
const UNKNOWN_DEF: ComponentDef<Record<string, never>> = {
  contract: { type: 'unknown', displayName: '未知组件', category: 'ui', events: {}, commands: {} },
  initialState: () => ({}),
  applyBinding: (s) => s,
  applyCommand: (s) => ({ state: s }),
}

const warnedTypes = new Set<string>()

export function getDef(type: string): ComponentDef<never> {
  const def = DEFS[type]
  if (!def) {
    if (!warnedTypes.has(type)) {
      warnedTypes.add(type)
      console.warn(`[store] 未知组件类型 "${type}"，已降级为占位组件（不影响其余组件运行）`)
    }
    return UNKNOWN_DEF as ComponentDef<never>
  }
  return def
}

export function allContracts(): ComponentDef<never>['contract'][] {
  return Object.values(DEFS).map((d) => d.contract)
}

export interface Snapshot<S = unknown> {
  state: S
  version: number
}

const MISSING_SNAPSHOT: Snapshot = { state: null, version: -1 }

export class ComponentStore {
  private specs = new Map<string, ComponentInstance>()
  private defs = new Map<string, ComponentDef<never>>()
  private states = new Map<string, unknown>()
  private versions = new Map<string, number>()
  private snaps = new Map<string, Snapshot>()
  private listeners = new Set<() => void>()
  private effectSink: ((id: string, effects: Effect[]) => void) | null = null

  /**
   * 效果出口：视图直调 applyCommand（如点击发音的 __strike）产生的影响
   * 也必须被执行——由 LevelSession 注册 sink，统一走同一条执行通道，
   * 避免视图拿到的返回值无人消费、效果静默丢失。
   */
  setEffectSink(sink: (id: string, effects: Effect[]) => void): void {
    this.effectSink = sink
  }

  init(specs: ComponentInstance[]): void {
    this.specs.clear()
    this.defs.clear()
    this.states.clear()
    this.versions.clear()
    this.snaps.clear()
    for (const spec of specs) {
      const def = getDef(spec.type)
      this.specs.set(spec.id, spec)
      this.defs.set(spec.id, def)
      this.states.set(spec.id, def.initialState(spec))
      this.versions.set(spec.id, 0)
      this.snaps.set(spec.id, { state: this.states.get(spec.id), version: 0 })
    }
  }

  spec(id: string): ComponentInstance | undefined {
    return this.specs.get(id)
  }

  snapshot(id: string): Snapshot {
    // 必须返回稳定引用：新对象会让 useSyncExternalStore 无限重渲染
    return this.snaps.get(id) ?? MISSING_SNAPSHOT
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private bump(id: string): void {
    this.versions.set(id, (this.versions.get(id) ?? 0) + 1)
    this.snaps.set(id, { state: this.states.get(id), version: this.versions.get(id)! })
    this.listeners.forEach((l) => l())
  }

  /** 题目装载时：解析后的绑定值写入组件状态 */
  applyBinding(id: string, key: string, value: Json): void {
    const def = this.defs.get(id)
    const state = this.states.get(id)
    if (!def || state === undefined) return
    this.states.set(id, def.applyBinding(state as never, key, value))
    this.bump(id)
  }

  /**
   * 命令 → 组件状态变更。产生的效果经 effectSink 统一交执行器
   * （规则链路与视图直调两条路径都走这里，返回值仅供测试断言）。
   */
  applyCommand(id: string, command: string, args: Record<string, Json>): Effect[] {
    const def = this.defs.get(id)
    const state = this.states.get(id)
    if (!def || state === undefined) {
      throw new Error(`命令目标不存在: ${id}.${command}`)
    }
    const { state: next, effects } = def.applyCommand(state as never, command, args)
    this.states.set(id, next)
    this.bump(id)
    const out = effects ?? []
    if (out.length > 0) this.effectSink?.(id, out)
    return out
  }

  /** 关卡重开：全部组件回到初始态 */
  resetAll(): void {
    for (const [id, def] of this.defs) {
      this.states.set(id, def.initialState(this.specs.get(id)!))
      this.bump(id)
    }
  }
}
