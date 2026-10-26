/**
 * v4 内置样例 builder 基建（docs/51 §6 / docs/52 W4.1）。
 *
 * 用意：10 个内置样例不再手写 JSON，而是由 TS builder 构造 `LevelDocV4`，
 * 再由 `generate.test.ts` 落盘为 `src/sample/v4/<name>.level.json`（新鲜度测试守护）。
 *
 * 约定：
 * - 组件 / 视图 / 节点一律使用**固定可读 id**（scoreLabel / prompt / choice1 / f_ask …），
 *   便于编辑器节点图、无头 golden 与数据变更属性测试引用；
 * - builder 只构造纯 JSON（无随机、无时间戳），同一源文件重复生成字节级一致；
 * - 节点不带 x/y：节点图由编辑器自动布局，避免样例手写坐标与布局算法打架；
 * - 本文件只依赖 `engine/v4/model` 的类型与常量，不反向依赖 runtime/store。
 *
 * 已知运行时限制（W2 内核当前实现，样例按可用子集编写）：
 * 1. `behavior.locals` 尚未在帧开始时自动初始化（docs/53 §7 的「每次调用初始化的 local.*」未实现），
 *    因此用到 `local.*` 的题型在 `on start` 里显式 `assign local.x = []` 初始化（见 keyboard-melody / rhythm-tap）；
 * 2. `choice.options` / `staff.music` 的挂载期绑定不生效（CHOICE_DEF/STAFF_DEF 的 initialState 不读
 *    props 里合并的绑定初值，且 applied 表会让后续 change-detection 跳过），因此这两个题型在
 *    `on start` 里显式发 `setOptions` / `setMusic` 命令；label 绑定（prompt）与 shell 绑定（v.*）正常。
 */
import type { Json } from '../../engine/expr'
import {
  LOGIC_VERSION_V4,
  SCHEMA_VERSION_V4,
  type AskNode,
  type AssignNode,
  type BehaviorNode,
  type BehaviorProgram,
  type BranchNode,
  type CallNode,
  type ColumnDefV4,
  type CommentNode,
  type ComponentInstanceV4,
  type EmitNode,
  type ExplicitManifest,
  type FinishNode,
  type FlowNode,
  type FlowProgram,
  type ForeachNode,
  type GraphEdge,
  type LevelDocV4,
  type LevelShell,
  type LoopNode,
  type OnNode,
  type ParamFieldDef,
  type QuestionRow,
  type QuestionTable,
  type QuestionTypeDef,
  type RestartNode,
  type ReturnNode,
  type RValue,
  type RunConfig,
  type SetViewNode,
  type StartNode,
  type StateFieldDef,
  type ViewDefV4,
  type WaitNode,
  type WaitShellNode,
} from '../../engine/v4/model'

// ---------------------------------------------------------------------------
// 舞台坐标（docs/53 §3.1：固定 800×470，单次 fit-scale）
// ---------------------------------------------------------------------------

export const STAGE = { width: 800, height: 470 } as const

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export function box(x: number, y: number, w: number, h: number): Box {
  return { x, y, w, h }
}

// ---------------------------------------------------------------------------
// 视图 / 组件实例
// ---------------------------------------------------------------------------

export interface ComponentOptions {
  name?: string
  /** shell 组件必填（属某个视图）；surface 组件禁止（题型区域整体渲染） */
  view?: string
  visible?: boolean
  layout?: Box
  props?: Record<string, Json>
  /** 只读绑定：槽位（label.text / choice.options / staff.music）→ 表达式 */
  bindings?: Record<string, string>
}

export function view(id: string, name?: string): ViewDefV4 {
  return name === undefined ? { id } : { id, name }
}

export function component(id: string, type: string, options: ComponentOptions = {}): ComponentInstanceV4 {
  const out: ComponentInstanceV4 = { id, type }
  if (options.name !== undefined) out.name = options.name
  if (options.visible !== undefined) out.visible = options.visible
  if (options.view !== undefined) out.view = options.view
  if (options.layout !== undefined) out.layout = options.layout
  if (options.props !== undefined) out.props = options.props
  if (options.bindings !== undefined) out.bindings = options.bindings
  return out
}

/** shell 组件：id/env 相同但必须声明归属视图 */
export function shellComponent(id: string, type: string, viewId: string, options: ComponentOptions = {}): ComponentInstanceV4 {
  return component(id, type, { ...options, view: viewId })
}

/** surface 本地组件：不允许 view（校验器会拒绝） */
export function surfaceComponent(id: string, type: string, options: ComponentOptions = {}): ComponentInstanceV4 {
  const { view: _ignored, ...rest } = options
  void _ignored
  return component(id, type, rest)
}

// ---------------------------------------------------------------------------
// 题型 / 状态字段 / 参数
// ---------------------------------------------------------------------------

export function stateField(key: string, type: StateFieldDef['type'], init: Json): StateFieldDef {
  return { key, type, init }
}

export function paramField(
  key: string,
  type: ParamFieldDef['type'],
  options: { optional?: boolean; default?: Json } = {},
): ParamFieldDef {
  const out: ParamFieldDef = { key, type }
  if (options.optional !== undefined) out.optional = options.optional
  if (options.default !== undefined) out.default = options.default
  return out
}

export interface QuestionTypeSpec {
  id: string
  name: string
  description?: string
  surface: ComponentInstanceV4[]
  behavior: BehaviorProgram
  state?: StateFieldDef[]
  typeState?: StateFieldDef[]
  args?: ParamFieldDef[]
}

export function questionType(spec: QuestionTypeSpec): QuestionTypeDef {
  const out: QuestionTypeDef = {
    id: spec.id,
    name: spec.name,
    surface: { components: spec.surface },
    behavior: spec.behavior,
  }
  if (spec.description !== undefined) out.description = spec.description
  if (spec.state !== undefined) out.state = spec.state
  if (spec.typeState !== undefined) out.typeState = spec.typeState
  if (spec.args !== undefined) out.args = spec.args
  return out
}

// ---------------------------------------------------------------------------
// 题型实例表（每型一张；行 = 题目）
// ---------------------------------------------------------------------------

export function column(key: string, type: ColumnDefV4['type'] = 'text', label?: string): ColumnDefV4 {
  const out: ColumnDefV4 = { key }
  if (label !== undefined) out.label = label
  if (type !== undefined) out.type = type
  return out
}

export interface RowOptions {
  /** 草稿行：不进入自动题单（显式题单仍可引用） */
  draft?: boolean
  /** 阶段（默认 1；只影响题单/发牌排序） */
  phase?: number
  /** 阶段内顺序（默认行下标） */
  order?: number
}

export function row(id: string, content: Record<string, Json>, options: RowOptions = {}): QuestionRow {
  const out: QuestionRow = { id }
  if (options.draft !== undefined) out.draft = options.draft
  if (options.phase !== undefined) out.phase = options.phase
  if (options.order !== undefined) out.order = options.order
  for (const [key, value] of Object.entries(content)) out[key] = value
  return out
}

export function table(columns: ColumnDefV4[], rows: QuestionRow[]): QuestionTable {
  return { columns, rows }
}

// ---------------------------------------------------------------------------
// 图 IR：通用构造助手
// ---------------------------------------------------------------------------

export type Port = 'true' | 'false'

export function edge(from: string, to: string, port?: Port): GraphEdge {
  const out: GraphEdge = { id: port === undefined ? `e_${from}_${to}` : `e_${from}_${to}_${port}`, from, to }
  if (port !== undefined) out.port = port
  return out
}

/** 顺序链：相邻 id 之间各一条边（单出口） */
export function chain(...ids: string[]): GraphEdge[] {
  const out: GraphEdge[] = []
  for (let i = 0; i + 1 < ids.length; i++) out.push(edge(ids[i], ids[i + 1]))
  return out
}

function rvalue(value: RValue | string): RValue {
  return typeof value === 'string' ? { expr: value } : value
}

// --- flow 节点 --------------------------------------------------------------

export function nStart(id: string): StartNode {
  return { id, kind: 'start' }
}

export function nAssign(id: string, target: string, value: RValue | string): AssignNode {
  return { id, kind: 'assign', target, value: rvalue(value) }
}

export function nCall(id: string, target: string, method: string, arg?: string): CallNode {
  const out: CallNode = { id, kind: 'call', target, method }
  if (arg !== undefined) out.arg = arg
  return out
}

export function nSetView(id: string, viewId: string): SetViewNode {
  return { id, kind: 'setView', view: viewId }
}

export function nAsk(id: string, target: string, resultVar: string, args?: string): AskNode {
  const out: AskNode = { id, kind: 'ask', target, resultVar }
  if (args !== undefined) out.args = args
  return out
}

export function nForeach(id: string, items: string, itemVar: string, indexVar?: string): ForeachNode {
  const out: ForeachNode = { id, kind: 'foreach', items, itemVar }
  if (indexVar !== undefined) out.indexVar = indexVar
  return out
}

export function nWaitShell(id: string, event: string): WaitShellNode {
  return { id, kind: 'waitShell', event }
}

export function nFinish(id: string, passed?: string): FinishNode {
  const out: FinishNode = { id, kind: 'finish' }
  if (passed !== undefined) out.passed = passed
  return out
}

export function nRestart(id: string): RestartNode {
  return { id, kind: 'restart' }
}

// --- flow / behavior 共享节点 ----------------------------------------------

export function nBranch(id: string, cond: string): BranchNode {
  return { id, kind: 'branch', cond }
}

export function nLoopWhile(id: string, cond: string): LoopNode {
  return { id, kind: 'loop', mode: 'while', cond }
}

export function nLoopRepeat(id: string, times: string): LoopNode {
  return { id, kind: 'loop', mode: 'repeat', times }
}

export function nWait(id: string, ms: string): WaitNode {
  return { id, kind: 'wait', ms }
}

export function nComment(id: string, text: string): CommentNode {
  return { id, kind: 'comment', text }
}

// --- behavior 专用节点 ------------------------------------------------------

export function nOn(id: string, event: string): OnNode {
  return { id, kind: 'on', event }
}

export function nReturn(id: string, result: string): ReturnNode {
  return { id, kind: 'return', result }
}

export function nEmit(id: string, event: string, payload?: Record<string, string>): EmitNode {
  const out: EmitNode = { id, kind: 'emit', event }
  if (payload !== undefined) out.payload = payload
  return out
}

// ---------------------------------------------------------------------------
// 程序（Flow main / Behavior 异步函数）
// ---------------------------------------------------------------------------

export function flowProgram(nodes: FlowNode[], edges: GraphEdge[], vars?: StateFieldDef[]): FlowProgram {
  const out: FlowProgram = { logicVersion: LOGIC_VERSION_V4, kind: 'flow', nodes, edges }
  if (vars !== undefined) out.vars = vars
  return out
}

export function behaviorProgram(nodes: BehaviorNode[], edges: GraphEdge[], locals?: StateFieldDef[]): BehaviorProgram {
  const out: BehaviorProgram = { logicVersion: LOGIC_VERSION_V4, kind: 'behavior', nodes, edges }
  if (locals !== undefined) out.locals = locals
  return out
}

// ---------------------------------------------------------------------------
// 行为预设片段（印章式：展开为普通节点，可被作者继续修改）
//
// 样例里的预设用法（docs/51 §3.5 / docs/53 §14）：
// - 首次答对只计一次分    → answeredGuard（on start / 重听 / 已答对守卫）+ q.state.answered
// - 答错可重试 / 锁题      → 错误分支只发反馈不 return（继续等事件）
// - 手动下一题 / 自动返回  → nextGate（手动收题）或 handler 直接 return（自动返回）
// - 限时返回               → timer.start + on timer.tick → return status:'timeout'
// - 结算后展示 / 重玩      → tutorial-hello 的 finish → setView → waitShell → restart
// ---------------------------------------------------------------------------

export interface Fragment {
  nodes: BehaviorNode[]
  edges: GraphEdge[]
  /** 片段入口（调用方把自己的边接进来） */
  entry: string
}

/**
 * 预设「首次答对只计一次分」的守卫尾巴：`branch q.state.answered → true: 立即返回（不重复计分）`。
 * 作为无 return 的副作用处理器（重听/重播/反馈）的静态可达 return，避免 V4_BEHAVIOR_NO_RETURN。
 * 运行期未答对时走 false 端口（无出边）自然结束，继续等待用户事件。
 */
export function answeredGuard(prefix: string, scoreDelta = '0'): Fragment {
  const guard = `${prefix}_guard`
  const ret = `${prefix}_guard_ret`
  return {
    nodes: [
      nBranch(guard, 'q.state.answered'),
      nReturn(ret, `{ status: 'answered', correct: true, scoreDelta: ${scoreDelta} }`),
    ],
    edges: [edge(guard, ret, 'true')],
    entry: guard,
  }
}

/**
 * 预设「手动下一题」：`branch q.state.answered → true: 计分返回 / false: 跳过返回`。
 * 用于需要先看反馈、再由「下一题」按钮收题的题型。
 */
export function nextGate(prefix: string, scoreDelta = 'q.scoring'): Fragment {
  const gate = `${prefix}_next`
  const scored = `${prefix}_next_scored`
  const skipped = `${prefix}_next_skipped`
  return {
    nodes: [
      nBranch(gate, 'q.state.answered'),
      nReturn(scored, `{ status: 'answered', correct: true, scoreDelta: ${scoreDelta} }`),
      nReturn(skipped, "{ status: 'skipped', correct: false, scoreDelta: 0 }"),
    ],
    edges: [edge(gate, scored, 'true'), edge(gate, skipped, 'false')],
    entry: gate,
  }
}

// ---------------------------------------------------------------------------
// flow 预设：顺序遍历题单 → ask → 应用 scoreDelta → finish（docs/51 §6 通用流程）
// ---------------------------------------------------------------------------

export interface SequenceFlowOptions {
  /** finish 的 passed 表达式（如 'v.score >= 20'；缺省恒过） */
  passExpr?: string
}

/**
 * 通用样例流程（8 个「每题即一槽位」的关卡共用；tutorial-hello 用自定义流程）：
 *
 * ```
 * start → foreach(run.questions) ─true→ ask(local.slot, result)
 *                                   ├→ v.score = v.score + (result.scoreDelta || 0)
 *                                   ├→ v.row = local.index + 1
 *                                   └→ 回边 foreach
 *            └false→ setView('settled') → finish(passed)
 * ```
 *
 * 结算后「重玩」由播放层 runner 的重玩按钮走 `session.restart()`（docs/53 §11）；
 * 流程图内的 `finish → waitShell → restart` 结算后流程由 tutorial-hello 专门演示（docs/51 §6）。
 */
export function sequenceFlow(options: SequenceFlowOptions = {}): FlowProgram {
  const passed = options.passExpr ?? 'true'
  const nodes: FlowNode[] = [
    nStart('f_start'),
    nForeach('f_each', 'run.questions', 'slot', 'index'),
    nAsk('f_ask', 'local.slot', 'result'),
    nAssign('f_addScore', 'v.score', 'v.score + (local.result.scoreDelta || 0)'),
    nAssign('f_setRow', 'v.row', 'local.index + 1'),
    nSetView('f_settled', 'settled'),
    nFinish('f_finish', passed),
    nComment('f_comment', '预设：顺序遍历题单 → 每题一次 ask → 应用 scoreDelta → 切结算视图 → 结算（数据增删不需要改本图）'),
  ]
  const edges: GraphEdge[] = [
    edge('f_start', 'f_each'),
    edge('f_each', 'f_ask', 'true'),
    edge('f_ask', 'f_addScore'),
    edge('f_addScore', 'f_setRow'),
    edge('f_setRow', 'f_each'),
    edge('f_each', 'f_settled', 'false'),
    edge('f_settled', 'f_finish'),
  ]
  return flowProgram(nodes, edges, [stateField('score', 'number', 0), stateField('row', 'number', 0)])
}

// ---------------------------------------------------------------------------
// shell 预设
// ---------------------------------------------------------------------------

/** 通用 shell：main 视图（标题 / 得分 / 进度）+ settled 视图（结算 + 重玩按钮） */
export function scoreShell(title: string, options: { main?: ComponentInstanceV4[]; settled?: ComponentInstanceV4[] } = {}): LevelShell {
  const main: ComponentInstanceV4[] = [
    shellComponent('titleLabel', 'label', 'main', {
      name: '关卡标题',
      layout: box(24, 12, 536, 28),
      props: { text: title },
    }),
    shellComponent('scoreLabel', 'label', 'main', {
      name: '得分',
      layout: box(600, 12, 176, 28),
      bindings: { text: "'得分 ' + v.score" },
    }),
    shellComponent('progressLabel', 'label', 'main', {
      name: '进度',
      layout: box(24, 42, 536, 24),
      bindings: { text: "'进度 ' + v.row + ' / ' + run.total" },
    }),
    ...(options.main ?? []),
  ]
  const settled: ComponentInstanceV4[] = [
    shellComponent('settledLabel', 'label', 'settled', {
      name: '结算文本',
      layout: box(200, 110, 400, 48),
      bindings: { text: "'本关得分 ' + v.score" },
    }),
    ...(options.settled ?? []),
  ]
  return {
    views: [view('main', '主视图'), view('settled', '结算视图')],
    components: [...main, ...settled],
  }
}

// ---------------------------------------------------------------------------
// 文档根
// ---------------------------------------------------------------------------

export const DEFAULT_RUN: RunConfig = { order: 'manifest', count: null, seed: null, shuffleWithinPhase: true }

/** 规范化 run 配置（样例 builder / 显式题单测试共用） */
export function runConfig(partial: Partial<RunConfig> = {}): RunConfig {
  return { ...DEFAULT_RUN, ...partial }
}

/** 显式题单构造助手（缺省自动题单的样例不用；属性测试/高阶作者可显式覆盖） */
export function manifestOf(entries: { type: string; row: string; args?: Json }[]): ExplicitManifest {
  return {
    entries: entries.map((entry) =>
      entry.args === undefined
        ? { type: entry.type, row: entry.row }
        : { type: entry.type, row: entry.row, args: entry.args },
    ),
  }
}

/** 内置样例通用 meta（沿用 v3 样例的作者 / 许可 / 语言字段） */
export interface SampleMetaSpec {
  title: string
  description: string
  tags: string[]
  difficulty: 1 | 2 | 3 | 4 | 5
  featured?: boolean
}

export function sampleMeta(spec: SampleMetaSpec): LevelDocV4['meta'] {
  const meta: LevelDocV4['meta'] = {
    title: spec.title,
    description: spec.description,
    author: { name: 'POC 内置示例' },
    tags: spec.tags,
    locale: 'zh-CN',
    license: 'CC0-1.0',
    difficulty: spec.difficulty,
  }
  if (spec.featured !== undefined) meta.featured = spec.featured
  return meta
}

export interface LevelDocSpec {
  /** 关卡 id（保留 v3 内置样例 id，便于 W9 覆盖装载与视觉矩阵引用） */
  id: string
  version: string
  meta: LevelDocV4['meta']
  shell: LevelShell
  types: QuestionTypeDef[]
  tables: Record<string, QuestionTable>
  manifest?: ExplicitManifest
  run?: Partial<RunConfig>
  flow: FlowProgram
}

export function levelDoc(spec: LevelDocSpec): LevelDocV4 {
  const run = runConfig(spec.run)
  const doc: LevelDocV4 = {
    schemaVersion: SCHEMA_VERSION_V4,
    kind: 'level',
    id: spec.id,
    version: spec.version,
    meta: spec.meta,
    content: {
      shell: spec.shell,
      types: spec.types,
      tables: spec.tables,
      ...(spec.manifest === undefined ? {} : { manifest: spec.manifest }),
      run,
      flow: spec.flow,
    },
  }
  return doc
}
