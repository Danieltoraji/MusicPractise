/**
 * 组件状态仓库：逻辑引擎的命令经由这里落到具体组件实例的状态上，
 * React 视图通过 useSyncExternalStore 订阅。
 */
import type { ComponentInstance } from '../engine/level'
import type { Json } from '../engine/expr'
import {
  BUTTON_DEF,
  CHOICE_DEF,
  LABEL_DEF,
  SOUND_DEF,
  STAFF_DEF,
  type ComponentDef,
  type Effect,
} from './componentDef'

const DEFS: Record<string, ComponentDef<never>> = {
  label: LABEL_DEF as ComponentDef<never>,
  button: BUTTON_DEF as ComponentDef<never>,
  choice: CHOICE_DEF as ComponentDef<never>,
  staff: STAFF_DEF as ComponentDef<never>,
  sound: SOUND_DEF as ComponentDef<never>,
}

export function getDef(type: string): ComponentDef<never> {
  const def = DEFS[type]
  if (!def) throw new Error(`未知组件类型: ${type}`)
  return def
}

export function allContracts(): ComponentDef<never>['contract'][] {
  return Object.values(DEFS).map((d) => d.contract)
}

export interface Snapshot<S = unknown> {
  state: S
  version: number
}

export class ComponentStore {
  private specs = new Map<string, ComponentInstance>()
  private defs = new Map<string, ComponentDef<never>>()
  private states = new Map<string, unknown>()
  private versions = new Map<string, number>()
  private snaps = new Map<string, Snapshot>()
  private listeners = new Set<() => void>()

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
    return this.snaps.get(id) ?? { state: null, version: -1 }
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

  /** 逻辑引擎命令 → 组件状态变更，返回需要宿主执行的效果 */
  applyCommand(id: string, command: string, args: Record<string, Json>): Effect[] {
    const def = this.defs.get(id)
    const state = this.states.get(id)
    if (!def || state === undefined) {
      throw new Error(`命令目标不存在: ${id}.${command}`)
    }
    const { state: next, effects } = def.applyCommand(state as never, command, args)
    this.states.set(id, next)
    this.bump(id)
    return effects ?? []
  }

  /** 关卡重开：全部组件回到初始态 */
  resetAll(): void {
    for (const [id, def] of this.defs) {
      this.states.set(id, def.initialState(this.specs.get(id)!))
      this.bump(id)
    }
  }
}
