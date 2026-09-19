/**
 * 关卡文档迁移器 v3（视图 + 数据表）。
 *
 * v3 结构变更（docs/20）：
 * - schemaVersion 1 → 3：content.questions 移除，改为 content.table（自定义列 × 行，q.* = 当前行）
 * - content.views 视图清单（≥1，template 至多一个）；组件归属视图（comp.view，缺省首视图）
 * - logicPatch.variables 编译为图上的数据装载子图：
 *     on level.questionLoaded → branch(event.row == i) → assign v.k = 字面量
 *   子图置于节点数组最前，保持旧「先补丁后处理器」时序；门控条件 v.__row == 行号
 *   （__row 为系统变量，LevelSession.loadRow 时写入；event.row 只存在于 questionLoaded 负载）
 *   补丁变量缺省补进 logic.variables = null
 * - logicPatch.appendRules（v1 规则）同样按行 gate 编译进图（内置关卡已无此形态，机制保留给旧用户文档）
 * - 行兼容：保留 prompt/data/scoring（及 hints/explanation）列，q.data.x / q.scoring.max 一字不改
 *
 * 纯函数、确定性：同输入逐字段同输出（golden 断言依赖）。
 */
import type { ComponentInstance, DataTable, LevelDoc, TableRow, ViewDef } from './level'
import type { GEdge, GNode, GraphProgram } from './graphProgram'
import { migrateLogicV1toV2 } from './migrate'
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

const DEFAULT_VIEW: ViewDef = { id: 'main', name: '主视图', template: true }

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
 * 任意受支持的关卡文档 → v3。幂等：v3 输入原样返回（浅拷贝壳）。
 * 抛错时消息面向用户（装载管线转为装载错误）。
 */
export function migrateDocToV3(raw: unknown): LevelDoc {
  if (raw === null || typeof raw !== 'object') throw new Error('关卡文档不是对象')
  const source = raw as { schemaVersion?: unknown; kind?: unknown; content?: unknown }
  if (source.kind !== 'level') throw new Error(`kind 不是 level（实际: ${String(source.kind)}）`)
  if (source.schemaVersion === 3) {
    // v3：仍兜底迁移逻辑 v1（用户可能手改 JSON），视图/表格由 schema 保证
    const doc = { ...(raw as LevelDoc), content: { ...((raw as LevelDoc).content as object) } } as LevelDoc
    doc.content.logic = migrateLogicV1toV2(doc.content.logic)
    return doc
  }
  if (source.schemaVersion !== 1) {
    throw new Error(`schemaVersion ${String(source.schemaVersion)} 不受支持（支持 1 → 自动升级 3）`)
  }
  const content = source.content as LegacyContent | undefined
  if (!content || typeof content !== 'object') throw new Error('content 缺失')

  // 1) 逻辑先行：v1 ECA → v2 图（保证后续编译产物的端口/节点协议成立）
  const logic = migrateLogicV1toV2(content.logic as never)

  // 2) 视图：已有则沿用；否则默认主视图（模板）。组件补 view 归属（缺省 = 首视图）
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
  return doc
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

    // on level.questionLoaded → gate(v.__row == i) → …
    const onId = `q${i}_load`
    const gateId = `q${i}_gate`
    prefixNodes.push({ id: reserve(onId), kind: 'on', event: 'level.questionLoaded' })
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
