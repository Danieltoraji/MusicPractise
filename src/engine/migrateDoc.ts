/**
 * 关卡文档迁移器 v3（视图 + 数据表）。
 *
 * v3 结构变更（docs/20）：
 * - schemaVersion 1 → 3：content.questions 移除，改为 content.table（自定义列 × 行，q.* = 当前行）
 * - content.views 视图清单（≥1）；组件归属视图（comp.view，缺省首视图）
 * - logicPatch.variables 编译为图上的数据装载子图：
 *     on question.loaded → branch(v.__row == i) → assign v.k = 字面量
 *   子图置于节点数组最前，保持旧「先补丁后处理器」时序；门控条件 v.__row == 行号
 *   （__row 为系统变量，LevelSession.loadRow 时写入、赋值即跳行；event.row 只存在于 question.loaded 负载）
 *   补丁变量缺省补进 logic.variables = null
 * - logicPatch.appendRules（v1 规则）同样按行 gate 编译进图（内置关卡已无此形态，机制保留给旧用户文档）
 * - 行兼容：保留 prompt/data/scoring（及 hints/explanation）列，q.data.x / q.scoring.max 一字不改
 *
 * docs/25 语义规范化（对 v1 迁移产物与已存 v3 文档都执行，幂等）：
 * - 事件/命令改名：level.questionLoaded → question.loaded、level.next → question.next
 *   （level.* 只留 started/finished/restart——节点图上「关卡」与「题目」概念分离）
 * - 剥离 views[].template（模版视图移除：换行不切视图，当前视图随行刷新）
 * - 数据表列补 type（text/number/boolean/notes/list/json 启发式；编辑器按类型渲染单元格，免 JSON 手输）
 *
 * docs/26 绑定机制移除（对 v1 迁移产物与已存 v3 文档都执行，幂等）：
 * - 组件静态 bindings（$q.列 → 组件状态）编译为图上的「数据应用」set 命令节点：
 *     on question.loaded → call <comp>.setText/setOptions/setMusic({ 字段: q.… })
 *     on view.entered    → branch(q != null) → 独立 call 链（守卫首帧 row 未装载）
 *   换行/进视图两个时机与原 applyBindings 重放语义对齐；随后从组件上剥离 bindings
 *   （schema 保留该字段声明，保证旧档先通过装载校验——「先放行后清洗」）
 *
 * docs/27 播放语义规范化（幂等）：sound/synth play 调用 UI 上不再提供 mode 参数——
 * 时序关系内化为音符串的 t（起始拍）字段；已有 mode 键保留为运行时兼容键（仅规范引号），
 * 缺失时按旧缺省 chord 显式化。规则详见 normalizePlayModes。
 *
 * 纯函数、确定性：同输入逐字段同输出（golden 断言依赖）。
 */
import type { ColumnType, ComponentInstance, DataTable, LevelDoc, TableRow, ViewDef } from './level'
import { DATA_APPLY_COMMANDS } from './level'
import type { GEdge, GNode, GraphProgram } from './graphProgram'
import { QUESTION_LOADED_EVENT } from './graphProgram'
import { jsonToExpr, migrateLogicV1toV2 } from './migrate'
import type { Json } from './expr'

/** 旧 questions 条目（v1/v2 文档形态，仅迁移器关心） */
interface LegacyQuestion {
  id?: string
  prompt?: Json
  data?: Json
  scoring?: Json
  hints?: Json
  explanation?: Json
  logicPatch?: { variables?: Record<string, Json>; appendRules?: unknown[] }
  [k: string]: unknown
}

const DEFAULT_VIEW: ViewDef = { id: 'main', name: '主视图' }

/** docs/25 改名前的旧事件/命令名（规范化改写源） */
const LEGACY_QUESTION_LOADED = 'level.questionLoaded'

/** 已知列的友好名（表格面板显示用；其余列用 key 本身） */
const KNOWN_COLUMN_LABELS: Record<string, string> = {
  prompt: '题面',
  data: '数据',
  scoring: '分值',
  hints: '提示',
  explanation: '解析',
}

/** Json → 表达式字面量源文本（对象键为标识符，与表达式引擎的对象字面量语法一致） */
export function jsonToExprSource(v: Json): string {
  if (v === null) return 'null'
  if (typeof v === 'string') {
    // 表达式词法只认 \n \t \r 与引号/反斜杠转义——控制字符/孤立代理对无法表达，诚实拒绝（评审 P2-2）
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) || /[\ud800-\udfff]/.test(v)) {
      throw new Error('数据含无法用表达式字面量表示的控制字符或孤立代理对')
    }
    return JSON.stringify(v)
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`数字无法用表达式字面量表示: ${v}`)
    // 表达式数字词法不支持科学计数法（评审 P2-1）：整数走 BigInt 精确展开（toFixed 对 ≥1e21 仍返回指数串），
    // 小数用 toFixed(20) 展开
    const s = String(v)
    if (!/e/i.test(s)) return s
    return Number.isInteger(v) ? BigInt(v).toString() : v.toFixed(20).replace(/\.?0+$/, '')
  }
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(jsonToExprSource).join(', ')}]`
  const parts = Object.entries(v).map(([k, val]) => `${k}: ${jsonToExprSource(val)}`)
  return `{ ${parts.join(', ')} }`
}

interface LegacyContent {
  components?: { view?: string; [k: string]: unknown }[]
  views?: ViewDef[]
  questions?: LegacyQuestion[]
  logic: unknown
  table?: DataTable
  flow?: unknown
  [k: string]: unknown
}

/**
 * 任意受支持的关卡文档 → v3。幂等：v3 输入仅做语义规范化（docs/25，见文件头）。
 * 抛错时消息面向用户（装载管线转为装载错误）。
 */
export function migrateDocToV3(raw: unknown): LevelDoc {
  if (raw === null || typeof raw !== 'object') throw new Error('关卡文档不是对象')
  const source = raw as { schemaVersion?: unknown; kind?: unknown; content?: unknown }
  if (source.kind !== 'level') throw new Error(`kind 不是 level（实际: ${String(source.kind)}）`)
  if (source.schemaVersion === 3) {
    // v3：仍兜底迁移逻辑 v1（用户可能手改 JSON），再做语义规范化
    const doc = { ...(raw as LevelDoc), content: { ...((raw as LevelDoc).content as object) } } as LevelDoc
    doc.content.logic = migrateLogicV1toV2(doc.content.logic)
    return { ...doc, content: normalizeV3Content(doc.content) }
  }
  if (source.schemaVersion !== 1) {
    throw new Error(`schemaVersion ${String(source.schemaVersion)} 不受支持（支持 1 → 自动升级 3）`)
  }
  const content = source.content as LegacyContent | undefined
  if (!content || typeof content !== 'object') throw new Error('content 缺失')

  // 1) 逻辑先行：v1 ECA → v2 图（保证后续编译产物的端口/节点协议成立）
  const logic = migrateLogicV1toV2(content.logic as never)

  // 2) 视图：已有则沿用；否则默认主视图。组件补 view 归属（缺省 = 首视图）
  const views: ViewDef[] =
    Array.isArray(content.views) && content.views.length > 0 ? content.views.map((v) => ({ ...v })) : [{ ...DEFAULT_VIEW }]
  const firstView = views[0].id
  const components = (content.components ?? []).map((c) => ({ ...c, view: c.view ?? firstView })) as ComponentInstance[]

  // 3) questions → 数据表：列 = 各题顶层字段并集（去 id/logicPatch，保持出现顺序）
  const questions = content.questions ?? []
  const columns: DataTable['columns'] = []
  for (const q of questions) {
    for (const key of Object.keys(q)) {
      if (key === 'id' || key === 'logicPatch') continue
      if (!columns.some((c) => c.key === key)) {
        columns.push({ key, label: KNOWN_COLUMN_LABELS[key] ?? key })
      }
    }
  }
  const rows: TableRow[] = questions.map((q) => {
    const row: TableRow = {}
    for (const c of columns) {
      const v = q[c.key]
      row[c.key] = v === undefined ? null : (v as Json)
    }
    return row
  })
  const table: DataTable = content.table ?? { columns, rows }

  // 4) logicPatch → 数据装载子图（variables 按行赋值；appendRules 按行 gate 编译）
  const compiled = compileLogicPatches(logic, questions)

  const doc: LevelDoc = {
    ...(raw as Omit<LevelDoc, 'schemaVersion' | 'content'>),
    schemaVersion: 3,
    content: {
      ...((content as unknown) as LevelDoc['content']),
      views,
      components,
      logic: compiled,
      table,
    },
  }
  delete (doc.content as Record<string, unknown>).questions
  return { ...doc, content: normalizeV3Content(doc.content) }
}

// ---------------------------------------------------------------------------
// docs/25 语义规范化（幂等纯函数）：question.* 改名 / 剥模版视图 / 列类型启发式
// ---------------------------------------------------------------------------

/** 图节点改名：on level.questionLoaded → question.loaded；call level.next → question.next（导出供直接迁移 v1 逻辑的管线对齐） */
export function normalizeLogic(prog: GraphProgram): GraphProgram {
  let changed = false
  const nodes = prog.nodes.map((n) => {
    if (n.kind === 'on' && n.event === LEGACY_QUESTION_LOADED) {
      changed = true
      return { ...n, event: QUESTION_LOADED_EVENT }
    }
    if (n.kind === 'call' && n.target === 'level' && n.method === 'next') {
      changed = true
      return { ...n, target: 'question', method: 'next' }
    }
    return n
  })
  return changed ? { ...prog, nodes } : prog
}

/** 音符串元素形态：{ midi: number, … }（notes 列启发式的判据） */
function isNoteLike(v: unknown): boolean {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as { midi?: unknown }).midi === 'number'
}

/** 行值启发式列类型：常见结构（音符串/字符串列表/数值/布尔）结构化编辑免 JSON 手输（docs/25） */
export function inferColumnType(values: Json[]): ColumnType {
  const vs = values.filter((v) => v !== null && v !== undefined)
  if (vs.length === 0) return 'text'
  if (vs.every((v) => typeof v === 'boolean')) return 'boolean'
  if (vs.every((v) => typeof v === 'number')) return 'number'
  if (vs.every((v) => Array.isArray(v) && v.length > 0 && v.every(isNoteLike))) return 'notes'
  if (vs.every((v) => Array.isArray(v) && v.every((x) => typeof x === 'string'))) return 'list'
  if (vs.every((v) => typeof v === 'object')) return 'json'
  return 'text'
}

/** v3 内容规范化：剥 template、改写 question.*、列类型缺省补全、bindings 编译为 set 命令节点、播放 mode 显式化（不 mutate 输入） */
function normalizeV3Content(content: LevelDoc['content']): LevelDoc['content'] {
  const rows = content.table?.rows ?? []
  const { logic: logicBound, components } = compileBindingsToNodes(normalizeLogic(content.logic), content.components ?? [])
  const logic = normalizePlayModes(logicBound, new Map(components.map((c) => [c.id, c.type])))
  return {
    ...content,
    views: (content.views ?? []).map((v) => {
      const { template: _legacy, ...rest } = v as ViewDef & { template?: unknown }
      return rest
    }),
    logic,
    components,
    table: {
      ...content.table,
      columns: (content.table?.columns ?? []).map((c) => ({
        ...c,
        type: c.type ?? inferColumnType(rows.map((r) => r[c.key] ?? null)),
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// docs/26：组件静态 bindings → 图上「数据应用」set 命令节点（幂等：转换后剥离 bindings）
// ---------------------------------------------------------------------------

/** 旧文档组件上的 bindings 形态（TS 类型已移除该字段，迁移器经 Json 层读取） */
type LegacyBindings = { bindings?: Record<string, Json> }

/** 顶层逗号切分（引号/括号感知，depth 不配对返回 null）——exprBridge.splitTopLevel 的引擎侧镜像 */
function splitTopLevel(src: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      cur += ch
      if (ch === '\\') {
        cur += src[i + 1] ?? ''
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++
      cur += ch
      continue
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      cur += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (depth !== 0 || quote !== null) return null
  parts.push(cur)
  return parts
}

/** play args 对象字面量 `{ k: v, … }` 的顶层键值切分；形态不符返回 null */
function playArgsEntries(src: string): { key: string; source: string }[] | null {
  const t = src.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  const parts = splitTopLevel(t.slice(1, -1))
  if (parts === null) return null
  const out: { key: string; source: string }[] = []
  for (const part of parts) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(part.trim())
    if (!m) return null
    out.push({ key: m[1], source: m[2].trim() })
  }
  return out
}

/**
 * docs/27 播放语义规范化（幂等）：sound/synth 的 play 调用 UI 上不再提供 mode——
 * 时序关系由音符串的 t（起始拍，缺省接排）表达。已有的 mode 键作为运行时兼容键
 * 原样保留（chord = 运行时折算全音 t:0 同时；seq = 运行时忽略即接排，均与旧语义一致），
 * 仅规范化引号形态；只对真正缺失 mode 的「旧缺省 chord」调用显式化：
 * - 缺 mode + notes 为多音字面量数组 → 每音补 t:0（同时发声）
 * - 缺 mode + notes 为动态引用 → 补写 mode:'chord' 兼容键（无法静态改写行数据）
 */
function normalizePlayModes(logic: GraphProgram, compTypes: Map<string, string>): GraphProgram {
  let changed = false
  const rebuild = (entries: { key: string; source: string }[]): string[] =>
    [`{ ${entries.map((e) => `${e.key}: ${e.source}`).join(', ')} }`]
  const nodes = logic.nodes.map((node) => {
    if (node.kind !== 'call' || node.method !== 'play') return node
    if (!Array.isArray(node.args) || typeof node.args[0] !== 'string') return node
    const compType = compTypes.get(node.target)
    if (compType !== 'sound' && compType !== 'synth') return node
    const entries = playArgsEntries(node.args[0])
    if (entries === null) return node
    const modeEntry = entries.find((e) => e.key === 'mode')
    const modeVal = modeEntry ? /^["']?(chord|seq)["']?$/.exec(modeEntry.source.trim())?.[1] ?? null : null
    if (modeVal !== null) {
      // 兼容键保留（语义与旧档一致），引号规范化为单引号形态（幂等收敛）
      const normalized = entries.map((e) => (e.key === 'mode' ? { ...e, source: `'${modeVal}'` } : e))
      const next = rebuild(normalized)
      if (next[0] === node.args[0]) return node
      changed = true
      return { ...node, args: next }
    }
    const notesEntry = entries.find((e) => e.key === 'notes')
    if (!notesEntry) return node
    const notesSrc = notesEntry.source
    if (notesSrc.startsWith('[')) {
      // 字面量数组：多音时每音补 t:0（单音同时/接排等价，不动）
      const inner = notesSrc.slice(1, -1)
      const parts = splitTopLevel(inner)
      if (parts === null || parts.length <= 1) return node
      let touched = false
      const patched = parts.map((p) => {
        const el = p.trim()
        if (!el.endsWith('}') || /\bt\s*:/.test(el)) return el
        touched = true
        return `${el.slice(0, -1).trimEnd()}, t: 0}`
      })
      if (!touched) return node
      changed = true
      return { ...node, args: rebuild(entries.map((e) => (e.key === 'notes' ? { ...e, source: `[${patched.join(', ')}]` } : e))) }
    }
    // 动态引用：显式化 chord 兼容键（单引号字符串字面量，与 script 往返规范化一致）
    changed = true
    return { ...node, args: rebuild([...entries, { key: 'mode', source: "'chord'" }]) }
  })
  return changed ? { ...logic, nodes } : logic
}

/**
 * 把每个组件的 bindings 编译为 set 命令节点，两个事件入口各持有一条独立链：
 *   on question.loaded → call×N（行装载后应用；row 必已就绪，无需守卫）
 *   on view.entered    → branch(q != null) → call×N（进视图重放；守卫首帧 row 未装载）
 * 两个入口语义相同（应用当前行数据）；不共享链节点——script 伪代码视图按处理器
 * 遍历渲染，跨处理器共享节点无法文本化（往返会丢节点），必须保持图在可文本化子集内。
 * 附加到既有节点之后（logicPatch 行门控前缀在前，时序不变）。
 */
function compileBindingsToNodes(logic: GraphProgram, components: ComponentInstance[]): {
  logic: GraphProgram
  components: ComponentInstance[]
} {
  // 1) 收集 (组件, 槽位) → set 命令调用；同时准备剥离 bindings 后的组件
  const comps = components.map((c) => ({ ...c })) as (ComponentInstance & LegacyBindings)[]
  const calls: { compId: string; method: string; argKey: string; expr: string }[] = []
  for (const comp of comps) {
    const bindings = comp.bindings
    delete comp.bindings
    if (!bindings || typeof bindings !== 'object') continue
    const slotMap = DATA_APPLY_COMMANDS[comp.type]
    for (const [slot, raw] of Object.entries(bindings)) {
      const cmd = slotMap?.[slot]
      if (!cmd) {
        console.warn(`[migrate] 绑定 ${comp.id}.${slot}（组件类型 ${comp.type}）没有对应的 set 命令，已丢弃（原运行时也是 no-op）`)
        continue
      }
      let expr: string
      try {
        expr = jsonToExpr(raw as Json)
      } catch (err) {
        console.warn(`[migrate] 绑定 ${comp.id}.${slot} 的值无法转为表达式，已丢弃: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      calls.push({ compId: comp.id, method: cmd.method, argKey: cmd.argKey, expr })
    }
  }
  if (calls.length === 0) return { logic, components: comps }

  // 2) 分配节点/边 id（与既有图撞车时加数字后缀，确定性分配）
  const usedIds = new Set<string>([...logic.nodes.map((n) => n.id), ...logic.edges.map((e) => e.id)])
  const alloc = (base: string): string => {
    let id = base
    for (let i = 2; usedIds.has(id); i++) id = `${base}_${i}`
    usedIds.add(id)
    return id
  }
  const sanitize = (s: string): string => s.replace(/\W/g, '_') || 'x'

  // 3) 生成节点与边：每个入口一条独立 call 链（view.entered 入口带 q != null 守卫）
  const nodes: GNode[] = []
  const edges: GEdge[] = []
  const chain = (suffix: string, headId: string, viaGuard: boolean): void => {
    const chainIds = calls.map((c, i) => {
      const id = alloc(`bnd${suffix}_${sanitize(c.compId)}_${sanitize(c.method)}_${i + 1}`)
      nodes.push({ id, kind: 'call', target: c.compId, method: c.method, args: [`{ ${c.argKey}: ${c.expr} }`] })
      return id
    })
    for (let i = 0; i + 1 < chainIds.length; i++) {
      edges.push({ id: alloc(`bnd${suffix}_e${i + 1}`), from: chainIds[i], to: chainIds[i + 1] })
    }
    if (viaGuard) {
      const guardId = alloc(`bnd${suffix}_vguard`)
      nodes.push({ id: guardId, kind: 'branch', cond: 'q != null' })
      edges.push({ id: alloc(`bnd${suffix}_ev`), from: headId, to: guardId })
      edges.push({ id: alloc(`bnd${suffix}_evg`), from: guardId, to: chainIds[0], port: 'true' })
    } else {
      edges.push({ id: alloc(`bnd${suffix}_eq`), from: headId, to: chainIds[0] })
    }
  }
  const onQId = alloc('bnd_qload')
  nodes.push({ id: onQId, kind: 'on', event: QUESTION_LOADED_EVENT })
  chain('_q', onQId, false)
  const onVId = alloc('bnd_venter')
  nodes.push({ id: onVId, kind: 'on', event: 'view.entered' })
  chain('_v', onVId, true)

  return {
    logic: { ...logic, nodes: [...logic.nodes, ...nodes], edges: [...logic.edges, ...edges] },
    components: comps,
  }
}

/** 把每题 logicPatch 编译为「行门控」子图并前置（保持先补丁后处理器的装载时序） */
function compileLogicPatches(logic: GraphProgram, questions: LegacyQuestion[]): GraphProgram {
  const hasAnyPatch = questions.some((q) => q.logicPatch && (Object.keys(q.logicPatch.variables ?? {}).length > 0 || (q.logicPatch.appendRules?.length ?? 0) > 0))
  if (!hasAnyPatch) return logic

  const prefixNodes: GNode[] = []
  const prefixEdges: GEdge[] = []
  // 前缀 id 与基础图撞车会让引擎索引互相覆盖（评审 P2-3）：编译期检测，诚实抛错
  const baseIds = new Set(logic.nodes.map((n) => n.id))
  const reserve = (id: string): string => {
    if (baseIds.has(id)) throw new Error(`逻辑节点 id "${id}" 与迁移编译产物冲突——请重命名基础图中的同名节点`)
    return id
  }
  // 补丁里出现过的变量键：缺省补进 variables（初值 null），避免 lint「未声明变量」误报；
  // __row = 运行时当前行号（系统变量，loadRow 时写入，行门控据此判行）
  const patchVarKeys = new Set<string>(['__row'])
  const nextEdgeId = (): string => `e_p${prefixEdges.length + 1}`

  questions.forEach((q, i) => {
    const patch = q.logicPatch
    if (!patch) return
    const vars = patch.variables ?? {}
    const rules = patch.appendRules ?? []
    const varKeys = Object.keys(vars)
    if (varKeys.length === 0 && rules.length === 0) return
    for (const k of varKeys) patchVarKeys.add(k)

    // on question.loaded → gate(v.__row == i) → …
    const onId = `q${i}_load`
    const gateId = `q${i}_gate`
    prefixNodes.push({ id: reserve(onId), kind: 'on', event: QUESTION_LOADED_EVENT })
    prefixNodes.push({ id: reserve(gateId), kind: 'branch', cond: `v.__row == ${i}` })
    prefixEdges.push({ id: nextEdgeId(), from: onId, to: gateId })

    let chainTail = gateId
    for (const k of varKeys) {
      const assignId = `q${i}_var_${k}`
      prefixNodes.push({ id: reserve(assignId), kind: 'assign', target: k, value: { expr: jsonToExprSource(vars[k] as Json) } })
      prefixEdges.push({ id: nextEdgeId(), from: chainTail, to: assignId, ...(chainTail === gateId ? { port: 'true' as const } : {}) })
      chainTail = assignId
    }

    if (rules.length > 0) {
      // v1 规则片段 → 图 → 前缀改名 → 从 gate(true) 串接；片段的每个 on 入口插入门控
      const frag = migrateLogicV1toV2({ variables: {}, rules: rules as never })
      const renamed = new Map<string, string>()
      const fragNodes = frag.nodes.map((n) => {
        const id = reserve(`q${i}_${n.id}`)
        renamed.set(n.id, id)
        return { ...n, id }
      })
      const fragEdges = frag.edges.map((e) => ({ ...e, id: `q${i}_${e.id}`, from: renamed.get(e.from) ?? e.from, to: renamed.get(e.to) ?? e.to }))
      // 每个 on 入口：on → 行门控 branch → 原目标（各片段链自门控，无需与变量链相连）
      for (const n of [...fragNodes]) {
        if (n.kind !== 'on') continue
        const outEdge = fragEdges.find((e) => e.from === n.id)
        if (!outEdge) continue
        const origTarget = outEdge.to
        const gId = `${n.id}_rowgate`
        outEdge.to = gId
        fragNodes.push({ id: gId, kind: 'branch', cond: `v.__row == ${i}` })
        fragEdges.push({ id: `${gId}_e`, from: gId, to: origTarget, port: 'true' })
      }
      prefixNodes.push(...fragNodes)
      prefixEdges.push(...fragEdges)
    }
  })

  // 变量缺省声明（初值 null：装载子图会在对应行载入时覆盖）
  const variables: Record<string, Json> = { ...(logic.variables ?? {}) }
  for (const k of patchVarKeys) if (!(k in variables)) variables[k] = null

  return {
    ...logic,
    variables,
    nodes: [...prefixNodes, ...logic.nodes],
    edges: [...logic.edges, ...prefixEdges],
  }
}
