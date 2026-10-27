/**
 * v4 关卡文档模型（docs/53 §2–§5）：类型、常量、限额、归一化与只读查询工具。
 *
 * 设计要点：
 * - v4 顶层直接是 `schemaVersion: 4`（不再「信封 1 + logicVersion 2」双版本）。
 * - 运行时执行的结构是 `LevelDocV4`：shell + types[] + tables{} + manifest? + run + flow。
 * - normalize 只补结构容器的缺省值（不改写作者语义），必须幂等，且不修改入参。
 * - 语义校验/引用校验/lint 在 `src/engine/v4/validate.ts` 与 `lint.ts`（W1 后续项）。
 */
import type { Json } from '../expr'
import type { ComponentInstance } from '../level'

export const SCHEMA_VERSION_V4 = 4 as const
export const LOGIC_VERSION_V4 = 3 as const

// ---------------------------------------------------------------------------
// 表现层：shell / surface / 组件
// ---------------------------------------------------------------------------

export interface ViewDefV4 {
  id: string
  name?: string
}

/**
 * v4 组件实例：字段与 v3 ComponentInstance 兼容（复用组件 store/视图渲染），
 * 新增只读绑定 `bindings`（槽位 → 表达式；docs/53 §3.2）。
 */
export interface ComponentInstanceV4 extends ComponentInstance {
  /** 只读投影：slot（label.text / choice.options / staff.music）→ 表达式 */
  bindings?: Record<string, string>
}

export interface LevelShell {
  views: ViewDefV4[]
  components: ComponentInstanceV4[]
  initialView?: string
}

/**
 * 题型表现层（surface）：`views`/`initialView` 是 v4.1 的「题型内视图」（docs/56）。
 * - 视图只过滤渲染：不重建组件 store，组件内部状态在同一题内跨视图保留；
 * - 组件 `view` 缺省 = 所有视图可见（题面/反馈这类常驻件），填写则只属于该视图；
 * - 每次 ask 都从 initialView 开始（与 shell 视图跨题持久的语义不同）。
 */
export interface QuestionSurface {
  views?: ViewDefV4[]
  initialView?: string
  components: ComponentInstanceV4[]
}

// ---------------------------------------------------------------------------
// 题型：定义 / 实例表 / 题单 / 发牌
// ---------------------------------------------------------------------------

export type StateType = 'number' | 'boolean' | 'string' | 'json'

export interface StateFieldDef {
  key: string
  type: StateType
  init: Json
}

export interface ParamFieldDef {
  key: string
  type: StateType
  optional?: boolean
  default?: Json
}

export interface ColumnDefV4 {
  key: string
  label?: string
  type?: 'text' | 'number' | 'boolean' | 'notes' | 'list' | 'json'
}

/**
 * 题目实例（qd 的一行）：平台元数据 + 内容列。
 * `id` 稳定（增删/重排不变），`draft` 不入自动题单，`phase`/`order` 只影响题单排序。
 */
export interface QuestionRow {
  id: string
  draft?: boolean
  phase?: number
  order?: number
  [contentKey: string]: Json | undefined
}

export interface QuestionTable {
  columns: ColumnDefV4[]
  rows: QuestionRow[]
}

export interface QuestionTypeDef {
  id: string
  name: string
  description?: string
  /** 题型本地组件（id 在题型内唯一，运行时内部命名空间隔离） */
  surface: QuestionSurface
  /** 题型行为：一次 ask 调用的异步函数（docs/53 §7） */
  behavior: BehaviorProgram
  /** q.state.* 初始 schema（每 (type,row) 一份，本局持久） */
  state?: StateFieldDef[]
  /** t.* 初始 schema（每题型一份，本局持久） */
  typeState?: StateFieldDef[]
  /** ask 调用参数 schema */
  args?: ParamFieldDef[]
}

export interface ManifestEntry {
  type: string
  row: string
  args?: Json
}

export interface ExplicitManifest {
  entries: ManifestEntry[]
}

export interface RunConfig {
  /** 默认 'manifest' */
  order: 'manifest' | 'shuffle'
  /** 默认 null = 全部 */
  count: number | null
  /** 默认 null = 每局随机并记录 */
  seed: number | string | null
  /** 默认 true：按 phase 分组、组内洗牌 */
  shuffleWithinPhase: boolean
}

/** 题单槽位（buildManifest 的中间产物） */
export interface ManifestSlot {
  type: string
  row: string
  args?: Json
  phase: number
  order: number
}

/** 本局牌堆项（对 flow 以只读 `run.questions` 暴露） */
export interface DeckItem extends ManifestSlot {
  slotIndex: number
}

// ---------------------------------------------------------------------------
// 逻辑 IR：FlowProgram（main）与 BehaviorProgram（题型异步函数）
// ---------------------------------------------------------------------------

export interface GraphEdge {
  id: string
  from: string
  to: string
  /** 双出口节点（branch/loop/foreach）用 'true'=body、'false'=exit；单出口省略 */
  port?: 'true' | 'false'
}

export interface QueryCall {
  target: string
  method: string
  arg?: string
}

export type RValue = { expr: string } | { query: QueryCall }

interface GNodeBaseV4 {
  id: string
  x?: number
  y?: number
}

export interface StartNode extends GNodeBaseV4 {
  kind: 'start'
}

export interface AssignNode extends GNodeBaseV4 {
  kind: 'assign'
  /** `v.<name>` / `q.state.<key>` / `t.<key>` / `local.<name>`（按层校验） */
  target: string
  value: RValue
}

export interface CallNode extends GNodeBaseV4 {
  kind: 'call'
  /** flow：shell 组件 id；behavior：本题 surface 本地组件 id */
  target: string
  method: string
  /** 表达式 → 单参对象；缺省 `{}` */
  arg?: string
}

export interface SetViewNode extends GNodeBaseV4 {
  kind: 'setView'
  view: string
}

export interface AskNode extends GNodeBaseV4 {
  kind: 'ask'
  /** 表达式 → DeckItem / { type, row, args? } */
  target: string
  /** 表达式 → 对象，覆盖 target.args */
  args?: string
  /** 结果写入 local.<resultVar> */
  resultVar: string
}

export interface ForeachNode extends GNodeBaseV4 {
  kind: 'foreach'
  /** 表达式 → 数组 */
  items: string
  itemVar: string
  indexVar?: string
}

export interface BranchNode extends GNodeBaseV4 {
  kind: 'branch'
  cond: string
}

export interface LoopNode extends GNodeBaseV4 {
  kind: 'loop'
  mode: 'while' | 'repeat'
  cond?: string
  times?: string
}

export interface WaitNode extends GNodeBaseV4 {
  kind: 'wait'
  ms: string
}

export interface WaitShellNode extends GNodeBaseV4 {
  kind: 'waitShell'
  /** `<shellCompId>.<eventName>` */
  event: string
}

export interface FinishNode extends GNodeBaseV4 {
  kind: 'finish'
  passed?: string
}

export interface RestartNode extends GNodeBaseV4 {
  kind: 'restart'
}

export interface CommentNode extends GNodeBaseV4 {
  kind: 'comment'
  text: string
}

export type FlowNode =
  | StartNode
  | AssignNode
  | CallNode
  | SetViewNode
  | AskNode
  | ForeachNode
  | BranchNode
  | LoopNode
  | WaitNode
  | WaitShellNode
  | FinishNode
  | RestartNode
  | CommentNode

export interface FlowProgram {
  logicVersion: typeof LOGIC_VERSION_V4
  kind: 'flow'
  nodes: FlowNode[]
  edges: GraphEdge[]
  /** run 作用域 v.* 的声明与初值（flow/预设维护） */
  vars?: StateFieldDef[]
}

export interface OnNode extends GNodeBaseV4 {
  kind: 'on'
  /** 'start' | 'internal.<name>' | '<surfaceCompId>.<eventName>' */
  event: string
}

export interface ReturnNode extends GNodeBaseV4 {
  kind: 'return'
  /** 表达式 → QuestionResult */
  result: string
}

export interface EmitNode extends GNodeBaseV4 {
  kind: 'emit'
  /** 必须 'internal.<name>' */
  event: string
  payload?: Record<string, string>
}

export type BehaviorNode =
  | OnNode
  | ReturnNode
  | AssignNode
  | CallNode
  | EmitNode
  | BranchNode
  | LoopNode
  | WaitNode
  | SetViewNode
  | CommentNode

export interface BehaviorProgram {
  logicVersion: typeof LOGIC_VERSION_V4
  kind: 'behavior'
  nodes: BehaviorNode[]
  edges: GraphEdge[]
  /** 每次调用的 local.* 初值 */
  locals?: StateFieldDef[]
}

// ---------------------------------------------------------------------------
// 文档根
// ---------------------------------------------------------------------------

export interface LevelContentV4 {
  shell: LevelShell
  /** 题型声明顺序 = 自动题单同 phase+order 的平票排序 */
  types: QuestionTypeDef[]
  /** key = 题型 id；与 types 一一对应 */
  tables: Record<string, QuestionTable>
  /** 缺省 = 自动题单；存在 = 显式优先 */
  manifest?: ExplicitManifest
  run: RunConfig
  flow: FlowProgram
}

export interface LevelDocV4 {
  schemaVersion: typeof SCHEMA_VERSION_V4
  kind: 'level'
  id: string
  version: string
  meta: { title: string; [k: string]: Json }
  refs?: unknown[]
  content: LevelContentV4
}

// ---------------------------------------------------------------------------
// QuestionResult 协议（docs/53 §9）
// ---------------------------------------------------------------------------

export type QuestionStatus = 'answered' | 'skipped' | 'timeout' | 'aborted' | 'error'

export const QUESTION_STATUSES: readonly QuestionStatus[] = [
  'answered',
  'skipped',
  'timeout',
  'aborted',
  'error',
] as const

export interface QuestionResult {
  status?: QuestionStatus
  correct?: boolean
  scoreDelta?: number
  payload?: Json
  message?: string
}

export interface RunResult {
  score: number
  passed: boolean
}

/** 运行时归一一题的返回值（docs/53 §9 第 5 步）；未知字段丢弃，非法字段降级为 error */
export function normalizeQuestionResult(raw: unknown): QuestionResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'error', message: '题型返回值不是对象（必须是 QuestionResult）' }
  }
  const src = raw as Record<string, Json | undefined>
  const out: QuestionResult = {}
  const status = src.status
  if (status === undefined) out.status = 'answered'
  else if (typeof status === 'string' && (QUESTION_STATUSES as readonly string[]).includes(status)) {
    out.status = status as QuestionStatus
  } else {
    return { status: 'error', message: `题型返回值 status 非法: ${JSON.stringify(status)}` }
  }
  if (src.correct !== undefined) {
    if (typeof src.correct !== 'boolean') return { status: 'error', message: '题型返回值 correct 必须是布尔' }
    out.correct = src.correct
  }
  if (src.scoreDelta !== undefined) {
    if (typeof src.scoreDelta !== 'number' || !Number.isFinite(src.scoreDelta)) {
      return { status: 'error', message: '题型返回值 scoreDelta 必须是有限数字' }
    }
    out.scoreDelta = src.scoreDelta
  }
  if (src.payload !== undefined) out.payload = src.payload
  if (src.message !== undefined) {
    if (typeof src.message !== 'string') return { status: 'error', message: '题型返回值 message 必须是字符串' }
    out.message = src.message
  }
  return out
}

// ---------------------------------------------------------------------------
// 常量：保留字 / id 形态 / 限额（与 schemas/v4/level.json 对齐，W1 同步）
// ---------------------------------------------------------------------------

/** 行上的平台元数据键，不得作为内容列 */
export const ROW_RESERVED_KEYS = ['id', 'draft', 'phase', 'order', 'state'] as const

/** 组件/变量 id 保留字：会与作用域根或平台伪实例冲突 */
export const RESERVED_LOCAL_IDS = [
  'level',
  'question',
  'views',
  'view',
  'run',
  'v',
  'q',
  't',
  'local',
  'args',
  'event',
  'state',
] as const

/** 本地 id 形态：字母/下划线开头，允许数字/下划线/短横，≤64，不得含 '.' */
export const LOCAL_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/

export function isV4LocalId(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_ID_PATTERN.test(value)
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 生成程序化本地 id（编辑器/样例 builder 用；严禁手抄随机 id 的场合由调用方决定） */
export function newLocalId(prefix: string): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return `${prefix}_${out}`
}

/** 在 existing 中查重后返回唯一 id（用于编辑器加行/加组件/加节点） */
export function newUniqueLocalId(prefix: string, existing: Iterable<string>): string {
  const used = new Set(existing)
  for (let i = 0; i < 64; i++) {
    const id = newLocalId(prefix)
    if (!used.has(id)) return id
  }
  throw new Error('无法生成唯一 id：同前缀 id 过多')
}

export const SCHEMA_LIMITS_V4 = {
  /** 每关题型数 */
  types: 12,
  /** 每型行数 */
  rowsPerType: 512,
  /** 每型列数 */
  columnsPerType: 32,
  /** 全关行合计 */
  rowsTotal: 1024,
  /** 显式题单条目数 */
  manifestEntries: 2048,
  /** 每型 surface 组件数 */
  surfaceComponentsPerType: 32,
  /** 每型题内视图数（v4.1 题型内视图） */
  surfaceViewsPerType: 16,
  /** shell 组件数 */
  shellComponents: 64,
  /** 视图数 */
  views: 16,
  /** 单程序节点数 */
  nodesPerProgram: 512,
  /** 单程序边数 */
  edgesPerProgram: 1024,
  /** 表达式源长度 */
  exprLength: 2000,
  /** 名称/标题长度 */
  nameLength: 120,
  /** 说明长度 */
  descriptionLength: 500,
} as const

// ---------------------------------------------------------------------------
// normalize：只补结构容器缺省值，幂等、不修改入参
// ---------------------------------------------------------------------------

/** JSON 深拷贝（文档内容恒为 JSON；顺带剥掉 undefined，避免 cfworker 校验器异常） */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function normalizeStateFields(value: unknown): StateFieldDef[] | undefined {
  if (value === undefined) return undefined
  return asArray(value).map((item) => {
    const f = asRecord(item)
    return {
      key: asString(f.key, ''),
      type: (typeof f.type === 'string' ? f.type : 'json') as StateType,
      init: (f.init ?? null) as Json,
    }
  })
}

function normalizeParamFields(value: unknown): ParamFieldDef[] | undefined {
  if (value === undefined) return undefined
  return asArray(value).map((item) => {
    const f = asRecord(item)
    const out: ParamFieldDef = { key: asString(f.key, ''), type: (typeof f.type === 'string' ? f.type : 'json') as StateType }
    if (typeof f.optional === 'boolean') out.optional = f.optional
    if (f.default !== undefined) out.default = f.default as Json
    return out
  })
}

function normalizeComponent(raw: unknown): ComponentInstanceV4 {
  const c = asRecord(raw)
  const out: ComponentInstanceV4 = { id: asString(c.id, ''), type: asString(c.type, '') }
  if (typeof c.name === 'string') out.name = c.name
  if (typeof c.visible === 'boolean') out.visible = c.visible
  if (typeof c.view === 'string') out.view = c.view
  if (c.layout !== undefined) out.layout = cloneJson(c.layout) as ComponentInstance['layout']
  if (c.props !== undefined) out.props = cloneJson(c.props) as Json
  const bindings = asRecord(c.bindings)
  const bindingOut: Record<string, string> = {}
  for (const [slot, expr] of Object.entries(bindings)) {
    if (typeof expr === 'string') bindingOut[slot] = expr
  }
  if (Object.keys(bindingOut).length > 0) out.bindings = bindingOut
  return out
}

function normalizeGraphContainers(raw: unknown): { nodes: unknown[]; edges: unknown[] } {
  const g = asRecord(raw)
  return { nodes: asArray(g.nodes), edges: asArray(g.edges) }
}

function normalizeFlow(raw: unknown): FlowProgram {
  const g = asRecord(raw)
  const { nodes, edges } = normalizeGraphContainers(g)
  const out: FlowProgram = {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'flow',
    nodes: cloneJson(nodes) as FlowNode[],
    edges: cloneJson(edges) as GraphEdge[],
  }
  const vars = normalizeStateFields(g.vars)
  if (vars !== undefined) out.vars = vars
  return out
}

function normalizeBehavior(raw: unknown): BehaviorProgram {
  const g = asRecord(raw)
  const { nodes, edges } = normalizeGraphContainers(g)
  const out: BehaviorProgram = {
    logicVersion: LOGIC_VERSION_V4,
    kind: 'behavior',
    nodes: cloneJson(nodes) as BehaviorNode[],
    edges: cloneJson(edges) as GraphEdge[],
  }
  const locals = normalizeStateFields(g.locals)
  if (locals !== undefined) out.locals = locals
  return out
}

function normalizeViews(raw: unknown): ViewDefV4[] {
  return asArray(raw).map((item) => {
    const v = asRecord(item)
    const view: ViewDefV4 = { id: asString(v.id, '') }
    if (typeof v.name === 'string') view.name = v.name
    return view
  })
}

function normalizeSurface(raw: unknown): QuestionSurface {
  const surface = asRecord(raw)
  const out: QuestionSurface = { components: asArray(surface.components).map(normalizeComponent) }
  if (surface.views !== undefined) out.views = normalizeViews(surface.views)
  if (typeof surface.initialView === 'string') out.initialView = surface.initialView
  return out
}

function normalizeType(raw: unknown): QuestionTypeDef {
  const t = asRecord(raw)
  const out: QuestionTypeDef = {
    id: asString(t.id, ''),
    name: asString(t.name, ''),
    surface: normalizeSurface(t.surface),
    behavior: normalizeBehavior(t.behavior),
  }
  if (typeof t.description === 'string') out.description = t.description
  const state = normalizeStateFields(t.state)
  if (state !== undefined) out.state = state
  const typeState = normalizeStateFields(t.typeState)
  if (typeState !== undefined) out.typeState = typeState
  const args = normalizeParamFields(t.args)
  if (args !== undefined) out.args = args
  return out
}

function normalizeTableView(raw: unknown): QuestionTable {
  const table = asRecord(raw)
  const columns = asArray(table.columns).map((item) => {
    const c = asRecord(item)
    const col: ColumnDefV4 = { key: asString(c.key, '') }
    if (typeof c.label === 'string') col.label = c.label
    if (typeof c.type === 'string') col.type = c.type as ColumnDefV4['type']
    return col
  })
  const rows = asArray(table.rows).map((item) => {
    const row = asRecord(item)
    const out: QuestionRow = { id: asString(row.id, '') }
    if (typeof row.draft === 'boolean') out.draft = row.draft
    if (typeof row.phase === 'number') out.phase = row.phase
    if (typeof row.order === 'number') out.order = row.order
    for (const [key, value] of Object.entries(row)) {
      if (key === 'id' || key === 'draft' || key === 'phase' || key === 'order') continue
      if (value !== undefined) out[key] = cloneJson(value) as Json
    }
    return out
  })
  return { columns, rows }
}

function normalizeShell(raw: unknown): LevelShell {
  const shell = asRecord(raw)
  const views = asArray(shell.views).map((item) => {
    const v = asRecord(item)
    const view: ViewDefV4 = { id: asString(v.id, '') }
    if (typeof v.name === 'string') view.name = v.name
    return view
  })
  const out: LevelShell = { views, components: asArray(shell.components).map(normalizeComponent) }
  if (typeof shell.initialView === 'string') out.initialView = shell.initialView
  return out
}

function normalizeRun(raw: unknown): RunConfig {
  const run = asRecord(raw)
  const seed = run.seed
  return {
    order: run.order === 'shuffle' ? 'shuffle' : 'manifest',
    count: typeof run.count === 'number' && Number.isFinite(run.count) ? run.count : null,
    seed: typeof seed === 'number' || typeof seed === 'string' ? seed : null,
    shuffleWithinPhase: run.shuffleWithinPhase !== false,
  }
}

function normalizeManifest(raw: unknown): ExplicitManifest | undefined {
  if (raw === undefined) return undefined
  const m = asRecord(raw)
  const entries = asArray(m.entries).map((item) => {
    const e = asRecord(item)
    const out: ManifestEntry = { type: asString(e.type, ''), row: asString(e.row, '') }
    if (e.args !== undefined) out.args = cloneJson(e.args) as Json
    return out
  })
  return { entries }
}

/**
 * 归一化 v4 文档：补全 content 各容器的结构缺省值。
 * 不做语义校验（缺 id/悬空引用/未知节点等留给 validate/lint），不修改入参。
 */
export function normalizeLevelDocV4(raw: unknown): LevelDocV4 {
  const src = asRecord(raw)
  const content = asRecord(src.content)
  const tablesRaw = asRecord(content.tables)
  const tables: Record<string, QuestionTable> = {}
  for (const typeId of Object.keys(tablesRaw)) tables[typeId] = normalizeTableView(tablesRaw[typeId])
  const manifest = normalizeManifest(content.manifest)
  const out: LevelDocV4 = {
    schemaVersion: SCHEMA_VERSION_V4,
    kind: 'level',
    id: asString(src.id, ''),
    version: asString(src.version, '1.0.0'),
    meta: cloneJson((src.meta ?? { title: '' }) as LevelDocV4['meta']),
    content: {
      shell: normalizeShell(content.shell),
      types: asArray(content.types).map(normalizeType),
      tables,
      run: normalizeRun(content.run),
      flow: normalizeFlow(content.flow),
    },
  }
  if (content.manifest !== undefined) out.content.manifest = manifest ?? { entries: [] }
  if (src.refs !== undefined) out.refs = cloneJson(src.refs) as unknown[]
  return out
}

// ---------------------------------------------------------------------------
// 只读查询工具（lint / session / editor 共用）
// ---------------------------------------------------------------------------

export function getType(doc: LevelDocV4, typeId: string): QuestionTypeDef | undefined {
  return doc.content.types.find((t) => t.id === typeId)
}

export function getTable(doc: LevelDocV4, typeId: string): QuestionTable | undefined {
  return doc.content.tables[typeId]
}

export function getRow(doc: LevelDocV4, typeId: string, rowId: string): QuestionRow | undefined {
  return doc.content.tables[typeId]?.rows.find((r) => r.id === rowId)
}

/** 行在题型表内的下标（-1 = 不存在） */
export function getRowIndex(doc: LevelDocV4, typeId: string, rowId: string): number {
  const rows = doc.content.tables[typeId]?.rows
  return rows ? rows.findIndex((r) => r.id === rowId) : -1
}

export function allRows(doc: LevelDocV4): { typeId: string; rowIndex: number; row: QuestionRow }[] {
  const out: { typeId: string; rowIndex: number; row: QuestionRow }[] = []
  for (const type of doc.content.types) {
    const rows = doc.content.tables[type.id]?.rows ?? []
    rows.forEach((row, rowIndex) => out.push({ typeId: type.id, rowIndex, row }))
  }
  return out
}

/** 全关行合计（限额校验用） */
export function countRows(doc: LevelDocV4): number {
  return allRows(doc).length
}

/** 深拷贝文档（撤销栈/编辑器/测试共用；文档恒为纯 JSON） */
export function cloneLevelDocV4(doc: LevelDocV4): LevelDocV4 {
  return cloneJson(doc)
}
