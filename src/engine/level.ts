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
 * 裁决（docs/25/26）：模版视图与静态 bindings 均移除——换行不切视图，
 * 行数据由节点图上的 set 命令节点（question.loaded/view.entered 驱动）应用；跳行 = 赋值 v.__row。
 */
export interface ViewDef {
  id: string
  name?: string
}

/** 列类型：编辑器按类型渲染单元格编辑器（迁移器按行数据启发式补全；缺省 text） */
export type ColumnType = 'text' | 'number' | 'boolean' | 'notes' | 'list' | 'json'

/** 数据表（v3）：与变量平权的自定义字段大表格，每行一条题目数据；q.* 指向当前行 */
export interface DataTable {
  columns: { key: string; label?: string; type?: ColumnType }[]
  rows: Record<string, Json>[]
}

/** 表格行（运行时 q 作用域）：列名 → 值 */
export type TableRow = Record<string, Json>

/**
 * docs/26「应用行数据」set 命令映射：组件类型 × 旧绑定槽位 → 命令与参数键。
 * 单一真源：迁移器（bindings → 图节点）、节点图 Inspector（图形化列选择特化）共用。
 * 运行时收敛实现在 componentDef 的 applyCommand；格式矩阵见 DATA_APPLY_ACCEPTED_TYPES。
 */
export const DATA_APPLY_COMMANDS: Record<string, Record<string, { method: string; argKey: string }>> = {
  label: { text: { method: 'setText', argKey: 'text' } },
  choice: { options: { method: 'setOptions', argKey: 'options' } },
  staff: { music: { method: 'setMusic', argKey: 'music' } },
}

/**
 * docs/26 格式判断矩阵：set 命令可接受的列类型。
 * accept = 完全匹配；soft = 可用但需保证形状（如 json 列存字符串数组），仅提示不拦截。
 * lint（graphProgram）与编辑器内联提示（TableFieldPicker）共用，防两端口径漂移。
 */
export const DATA_APPLY_ACCEPTED_TYPES: Record<string, { accept: ColumnType[]; soft?: ColumnType[]; hint: string }> = {
  setText: { accept: ['text', 'number', 'boolean'], hint: '文本标签需要 文本/数字/布尔 列（对象/数组无法显示）' },
  setOptions: { accept: ['list'], soft: ['json'], hint: '选择器选项需要 文本列表 列（json 列需存字符串数组）' },
  setMusic: { accept: ['json'], hint: '五线谱需要 JSON 列（存乐谱对象 MusicDoc）' },
}

/** 列类型的中文显示名（lint 消息 / 编辑器下拉共用） */
export const COLUMN_TYPE_LABELS: Record<ColumnType, string> = {
  text: '文本',
  number: '数字',
  boolean: '布尔',
  notes: '音符串',
  list: '文本列表',
  json: 'JSON',
}

export interface ComponentInstance {
  id: string
  type: string
  name?: string
  visible?: boolean
  /** 所属视图 id（互斥渲染的归属；缺省视为首视图，装载管线会补齐） */
  view?: string
  layout?: { x: number; y: number; w: number; h: number }
  props?: Json
  // 历史说明：v3 早期存在 bindings（$q.列 → 组件状态的静态绑定），已被移除（docs/26）；
  // 旧文档由迁移器编译为 set 命令节点后剥离（schema 保留该字段声明以保证装载通畅）
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
    /** 视图清单（≥1；缺省视图 = 首个） */
    views: ViewDef[]
    components: ComponentInstance[]
    /** 关卡逻辑：GraphProgram v2 图 IR（v1 ECA 在装载管线透明迁移） */
    logic: import('./graphProgram').GraphProgram
    /** 题目数据表格（v3 取代 questions；q.* = 当前行） */
    table: DataTable
    flow?: FlowConfig
  }
}
