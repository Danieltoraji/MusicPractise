/** 关卡文档运行时类型（schemaVersion 3；与 schemas/v1/level.json 的 V3 定义对应） */
import type { Json } from './expr'

export interface Note {
  midi: number
  dur?: string
  vel?: number
}

export interface MusicDoc {
  notes: Note[]
  clef?: 'treble' | 'alto' | 'bass'
  timeSig?: [number, number]
  tempo?: number
  key?: string
}

/**
 * 视图（v3）：互斥的表现层边界——同一时刻只渲染当前视图的组件。
 * 裁决（docs/20）：视图不划分变量作用域与逻辑图作用域（v.* 全局、单图）；
 * 事件隔离由「非当前视图组件不渲染 → 不发事件」免费获得。
 * template：至多一个的「模版视图」——level.next 推进表格行后自动 goto 到它
 * 并按当前行重放数据绑定，即「显示题目」的低代码抽象。
 */
export interface ViewDef {
  id: string
  name?: string
  template?: boolean
}

/** 数据表（v3）：与变量平权的自定义字段大表格，每行一条题目数据；q.* 指向当前行 */
export interface DataTable {
  columns: { key: string; label?: string }[]
  rows: Record<string, Json>[]
}

/** 表格行（运行时 q 作用域）：列名 → 值 */
export type TableRow = Record<string, Json>

export interface ComponentInstance {
  id: string
  type: string
  name?: string
  visible?: boolean
  /** 所属视图 id（互斥渲染的归属；缺省视为首视图，装载管线会补齐） */
  view?: string
  layout?: { x: number; y: number; w: number; h: number }
  props?: Json
  bindings?: Record<string, Json>
}

export interface FlowConfig {
  order?: 'sequential' | 'shuffle'
  count?: number | null
  pass?: { expr: string }
}

export interface LevelDoc {
  schemaVersion: 3
  kind: 'level'
  id: string
  version: string
  meta: { title: string; [k: string]: Json }
  refs?: unknown[]
  content: {
    /** 视图清单（≥1；template 至多一个；缺省视图 = 首个） */
    views: ViewDef[]
    components: ComponentInstance[]
    /** 关卡逻辑：GraphProgram v2 图 IR（v1 ECA 在装载管线透明迁移） */
    logic: import('./graphProgram').GraphProgram
    /** 题目数据表格（v3 取代 questions；q.* = 当前行） */
    table: DataTable
    flow?: FlowConfig
  }
}
