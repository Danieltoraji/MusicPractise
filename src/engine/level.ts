/** 关卡文档运行时类型（与 schemas/v1/level.json 对应） */
import type { Json } from './expr'

export interface Note {
  midi: number
  dur?: string
  vel?: number
}

export interface MusicDoc {
  notes: Note[]
  clef?: 'treble' | 'bass'
  timeSig?: [number, number]
  tempo?: number
  key?: string
}

export interface ComponentInstance {
  id: string
  type: string
  name?: string
  visible?: boolean
  layout?: { x: number; y: number; w: number; h: number }
  props?: Json
  bindings?: Record<string, Json>
}

export interface Question {
  id: string
  prompt?: { text?: string; audio?: string; image?: string }
  data: Json
  scoring?: { max?: number }
  hints?: { text: string }[]
  explanation?: string
  logicPatch?: {
    /** 装载本题时 merge 进引擎变量（覆盖初值） */
    variables?: Record<string, Json>
    /** 本题期间生效的追加规则，换题/重开时移除 */
    appendRules?: import('./logic').Rule[]
  }
}

export interface FlowConfig {
  order?: 'sequential' | 'shuffle'
  count?: number | null
  pass?: { expr: string }
}

export interface LevelDoc {
  schemaVersion: 1
  kind: 'level'
  id: string
  version: string
  meta: { title: string; [k: string]: Json }
  refs?: unknown[]
  content: {
    components: ComponentInstance[]
    logic: import('./logic').LogicProgram
    questions: Question[]
    flow?: FlowConfig
  }
}
