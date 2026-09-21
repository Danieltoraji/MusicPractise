/**
 * GraphProgram：关卡逻辑 IR v2（唯一真源）。
 *
 * 三视图（节点图 / LevelScript 伪代码 / JSON）都是它的投影；执行器（GraphEngine，3-1）
 * 沿执行边行走。本文件只放类型、编辑纯函数（graphOps）与装载期 lint——执行语义在引擎里。
 *
 * 语义定式（docs/12）：
 * - args/payload 一律是 expr 源文本（含对象字面量），代码往返无损
 * - 查询方法只出现在 assign 右侧（RValue.call），表达式本体无副作用
 * - loop = 带内部状态的 branch（真→体、假→false 边、体沿边回环），死循环由节点预算兜底
 * - on 节点无入边；comment 无执行语义；无出边 = 处理器结束
 */

import type { Json } from './expr'
import { evalExpr, ExprError } from './expr'

export interface GraphProgram {
  logicVersion: 2
  variables?: Record<string, Json>
  nodes: GNode[]
  edges: GEdge[]
}

export interface GNodeBase {
  id: string
  /** 画布位置，仅视图用，无执行语义 */
  x?: number
  y?: number
}

export type GNode = GNodeBase &
  (
    | { kind: 'on'; event: string }
    | { kind: 'assign'; target: string; value: RValue }
    | { kind: 'call'; target: string; method: string; args: string[] }
    | { kind: 'emit'; event: string; payload?: Record<string, string> }
    | { kind: 'branch'; cond: string }
    | { kind: 'loop'; mode: 'while' | 'repeat'; cond?: string; times?: string }
    | { kind: 'wait'; ms: string }
    | { kind: 'comment'; text: string }
  )

export type GNodeKind = GNode['kind']

/** 赋值右侧：普通表达式，或一次查询方法调用（如 v.cents = tuner1.getReading()） */
export type RValue = { expr: string } | { call: { target: string; method: string; args: string[] } }

export interface GEdge {
  id: string
  from: string
  to: string
  /** branch/loop 的出口；缺省 = 无条件出口 */
  port?: 'true' | 'false'
}

/** 行指针系统变量：运行时当前行号（0 起）。赋值即跳转题目行（LevelSession 注入钩子），lint 豁免声明 */
export const ROW_POINTER_VAR = '__row'

/** 题目载入事件（docs/25 改名；旧名 level.questionLoaded 由迁移器幂等改写） */
export const QUESTION_LOADED_EVENT = 'question.loaded'

/** level facade 暴露给逻辑的方法（伪实例 id = "level"）；换行/跳行走 question 伪实例与 v.__row */
export const LEVEL_METHODS = ['restart', 'finish'] as const

/** question 伪实例的方法：next = 推进到下一题（末题则结算关卡） */
export const QUESTION_METHODS = ['next'] as const

/** views 伪实例的方法（v3 视图切换）；goto 的参数 = 视图 id 字符串字面量 */
export const VIEWS_METHODS = ['goto'] as const

/** 判定一段未知 JSON 是否为 GraphProgram（装载/导入管线用） */
export function isGraphProgram(x: unknown): x is GraphProgram {
  if (x === null || typeof x !== 'object') return false
  const p = x as Record<string, unknown>
  if (p.logicVersion !== 2 || !Array.isArray(p.nodes) || !Array.isArray(p.edges)) return false
  if (p.variables !== undefined) {
    if (p.variables === null || typeof p.variables !== 'object' || Array.isArray(p.variables)) return false
  }
  return true
}

export function blankGraphProgram(): GraphProgram {
  return { logicVersion: 2, variables: { score: 0 }, nodes: [], edges: [] }
}

// ---------------------------------------------------------------------------
// graphOps：编辑纯函数（不可变更新，非法操作抛 Error 供 UI 呈现）
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 生成未占用的节点 id：n1, n2, … */
export function newNodeId(prog: GraphProgram): string {
  const used = new Set(prog.nodes.map((n) => n.id))
  let i = prog.nodes.length + 1
  while (used.has(`n${i}`)) i++
  return `n${i}`
}

function clone(prog: GraphProgram): GraphProgram {
  return structuredClone(prog)
}

export function findNode(prog: GraphProgram, id: string): GNode | undefined {
  return prog.nodes.find((n) => n.id === id)
}

function requireNode(prog: GraphProgram, id: string): GNode {
  const node = findNode(prog, id)
  if (!node) throw new Error(`节点不存在: ${id}`)
  return node
}

export function addNode(prog: GraphProgram, node: GNode): GraphProgram {
  if (!ID_RE.test(node.id)) throw new Error(`非法节点 id: ${node.id}`)
  if (findNode(prog, node.id)) throw new Error(`节点 id 已存在: ${node.id}`)
  const next = clone(prog)
  next.nodes.push(node)
  return next
}

/** 删除节点并级联删除其关联边 */
export function removeNode(prog: GraphProgram, id: string): GraphProgram {
  const next = clone(prog)
  next.nodes = next.nodes.filter((n) => n.id !== id)
  next.edges = next.edges.filter((e) => e.from !== id && e.to !== id)
  return next
}

/** 局部更新节点字段（不含 id；kind 变更时原有关联边保留，由调用方决定是否清理） */
export function updateNode<N extends GNode>(prog: GraphProgram, id: string, patch: Partial<Omit<N, 'id'>>): GraphProgram {
  requireNode(prog, id)
  const next = clone(prog)
  const idx = next.nodes.findIndex((n) => n.id === id)
  // patch 中显式 undefined = 删除该字段（如 loop 由 while 切 repeat 时清除 cond），
  // 避免节点上留下显式 undefined 键（JSON 序列化与内存 doc 不同构）
  const merged = { ...next.nodes[idx] } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  next.nodes[idx] = merged as unknown as GNode
  return next
}

export function moveNode(prog: GraphProgram, id: string, x: number, y: number): GraphProgram {
  return updateNode(prog, id, { x, y })
}

/**
 * 连一条执行边。规则：
 * - on 不能作为 to（事件入口无入边）
 * - branch/loop 出边必须带 port（'true'|'false'），其余节点出边不能带 port
 * - 同一 (from, port) 只保留一条出边，重复连接替换旧边
 * - 允许自环（空循环体等，运行时由节点预算兜底）；comment 执行时直通，可参与连线
 */
export function connect(prog: GraphProgram, from: string, to: string, port?: 'true' | 'false'): GraphProgram {
  const f = requireNode(prog, from)
  const t = requireNode(prog, to)
  if (t.kind === 'on') throw new Error('事件入口节点（on）不能有入边')
  const needsPort = f.kind === 'branch' || f.kind === 'loop'
  if (needsPort && port !== 'true' && port !== 'false') throw new Error(`${f.kind} 节点的出边必须选择端口 true/false`)
  if (!needsPort && port !== undefined) throw new Error(`${f.kind} 节点的出边不接受端口`)
  const next = clone(prog)
  next.edges = next.edges.filter((e) => !(e.from === from && e.port === port))
  const used = new Set(next.edges.map((e) => e.id))
  let i = next.edges.length + 1
  while (used.has(`e${i}`)) i++
  next.edges.push({ id: `e${i}`, from, to, ...(port ? { port } : {}) })
  return next
}

export function disconnect(prog: GraphProgram, edgeId: string): GraphProgram {
  const next = clone(prog)
  next.edges = next.edges.filter((e) => e.id !== edgeId)
  return next
}

// ---------------------------------------------------------------------------
// 变量操作（与 docState 变量函数同语义：表达式文本中的旧引用不做替换，由 lint 提示）
// ---------------------------------------------------------------------------

export function setGraphVariable(prog: GraphProgram, name: string, value: Json): GraphProgram {
  if (name === ROW_POINTER_VAR) throw new Error('__row 是行指针系统变量（赋值即跳题），无需声明')
  if (!ID_RE.test(name)) throw new Error(`非法变量名: ${name}`)
  const next = clone(prog)
  next.variables = { ...next.variables, [name]: value }
  return next
}

export function renameGraphVariable(prog: GraphProgram, oldName: string, newName: string): GraphProgram {
  if (oldName === ROW_POINTER_VAR || newName === ROW_POINTER_VAR) throw new Error('__row 是行指针系统变量，不可改名')
  if (!ID_RE.test(newName)) throw new Error(`非法变量名: ${newName}`)
  if (oldName === newName) return prog
  if (oldName !== newName && newName in (prog.variables ?? {})) throw new Error(`变量名已存在: ${newName}`)
  const next = clone(prog)
  const vars: Record<string, Json> = {}
  for (const [k, v] of Object.entries(next.variables ?? {})) vars[k === oldName ? newName : k] = v
  next.variables = vars
  for (const node of next.nodes) {
    if (node.kind === 'assign' && node.target === oldName) node.target = newName
  }
  return next
}

export function removeGraphVariable(prog: GraphProgram, name: string): GraphProgram {
  if (name === ROW_POINTER_VAR) throw new Error('__row 是行指针系统变量，不可删除')
  const next = clone(prog)
  const vars = { ...(next.variables ?? {}) }
  delete vars[name]
  next.variables = vars
  return next
}

// ---------------------------------------------------------------------------
// 装载期 lint
// ---------------------------------------------------------------------------

const EVENT_RE = /^[A-Za-z_][A-Za-z0-9_]*([.:][A-Za-z_][A-Za-z0-9_]*)+$/

export type LintCode =
  | 'syntax'
  | 'undeclared-var'
  | 'dangling-ref'
  | 'structure'
  | 'port'
  | 'duplicate-edge'
  | 'unknown-kind'
  | 'emit-cycle'

/** 结构化 lint 结果：nodeId/field 直接定位到节点图与代码视图的出错位置 */
export interface LintIssue {
  code: LintCode
  message: string
  nodeId?: string
  edgeId?: string
  field?: string
}

export interface GraphLintCtx {
  /** 组件 id 集合：提供时做悬空实例检查 */
  componentIds?: Iterable<string>
  /** 题目 logicPatch.variables 声明的变量豁免 */
  extraVariableKeys?: Iterable<string>
  /** 视图 id 集合（v3）：views.goto 的字面量参数据此校验 */
  viewIds?: Iterable<string>
}

/** 收集节点中出现的全部表达式源文本（仅在字段为字符串时收集，schema 问题由 structure 检查报告） */
function exprTexts(node: GNode): [string, string][] {
  const out: [string, string][] = []
  const push = (field: string, v: unknown): void => {
    if (typeof v === 'string') out.push([field, v])
  }
  const rvalue = (label: string, rv: RValue | undefined) => {
    if (!rv || typeof rv !== 'object') return
    if ('expr' in rv) push(`${label}.expr`, rv.expr)
    else if ('call' in rv) rv.call.args?.forEach((a, i) => push(`${label}.call 参数[${i}]`, a))
  }
  switch (node.kind) {
    case 'assign':
      rvalue('value', node.value)
      break
    case 'call':
      node.args?.forEach((a, i) => push(`args[${i}]`, a))
      break
    case 'branch':
      push('cond', node.cond)
      break
    case 'loop':
      push('cond', node.cond)
      push('times', node.times)
      break
    case 'wait':
      push('ms', node.ms)
      break
    case 'emit':
      for (const [k, v] of Object.entries(node.payload ?? {})) push(`payload.${k}`, v)
      break
    default:
      break
  }
  return out
}

const VAR_REF_RE = /\bv\.([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * GraphProgram 结构化校验（字符串消息版见 lintGraphProgram）。
 * 覆盖：未知类型/缺失字段、节点 id 重复、边引用与端口协议、重复 (from, port) 出边、
 * 表达式语法、变量声明（赋值目标 + 表达式 v.* 引用）、实例存在性、level 方法白名单、
 * on 入边、emit 事件格式与触发环。
 * 方法存在性校验（契约 v2）在 3-1 执行器批次接入。
 */
export function lintGraphProgramDetailed(program: GraphProgram, ctx?: GraphLintCtx): LintIssue[] {
  const issues: LintIssue[] = []
  const compIds = ctx?.componentIds ? new Set(ctx.componentIds) : null
  const viewIdSet = ctx?.viewIds ? new Set(ctx.viewIds) : null
  // 行指针是系统级声明（LevelSession 装载行时写入、赋值即跳行），无需在 variables 里声明
  const declaredVars = new Set<string>([ROW_POINTER_VAR, ...(ctx?.extraVariableKeys ?? [])])
  for (const key of Object.keys(program.variables ?? {})) declaredVars.add(key)

  // 0) schema：未知类型与必填字段
  for (const node of program.nodes as GNode[]) {
    const where = `节点 ${node.id}(${String((node as { kind?: string }).kind)})`
    const structural = (field: string, problem: string): LintIssue => ({
      code: 'structure',
      nodeId: node.id,
      field,
      message: `${where}: ${field} ${problem}`,
    })
    switch (node.kind) {
      case 'on':
        break
      case 'assign': {
        if (typeof node.target !== 'string' || !node.target) issues.push(structural('target', '缺失'))
        const v = node.value as unknown
        if (v === null || typeof v !== 'object') issues.push(structural('value', '缺失'))
        break
      }
      case 'call': {
        if (typeof node.target !== 'string' || !node.target) issues.push(structural('target', '缺失'))
        if (typeof node.method !== 'string' || !node.method) issues.push(structural('method', '缺失'))
        if (!Array.isArray(node.args)) issues.push(structural('args', '缺失（应为数组）'))
        break
      }
      case 'emit':
        break
      case 'branch':
        if (typeof node.cond !== 'string' || !node.cond) issues.push(structural('cond', '缺失'))
        break
      case 'loop': {
        if (node.mode !== 'while' && node.mode !== 'repeat') issues.push(structural('mode', '必须是 while 或 repeat'))
        else if (node.mode === 'while' && typeof node.cond !== 'string') issues.push(structural('cond', '缺失（while 需要 cond）'))
        else if (node.mode === 'repeat' && typeof node.times !== 'string') issues.push(structural('times', '缺失（repeat 需要 times）'))
        break
      }
      case 'wait':
        if (typeof node.ms !== 'string' || !node.ms) issues.push(structural('ms', '缺失'))
        break
      case 'comment':
        if (typeof node.text !== 'string') issues.push(structural('text', '缺失'))
        break
      default: {
        const unknown = node as { id: string; kind?: string }
        issues.push({
          code: 'unknown-kind',
          nodeId: unknown.id,
          message: `节点 ${unknown.id}: 未知类型 "${String(unknown.kind)}"`,
        })
      }
    }
  }

  // 1) 节点 id 唯一性 + 边引用完整性
  const seen = new Set<string>()
  for (const node of program.nodes) {
    if (seen.has(node.id)) issues.push({ code: 'structure', nodeId: node.id, message: `节点 id 重复: ${node.id}` })
    seen.add(node.id)
  }
  const byId = new Map(program.nodes.map((n) => [n.id, n]))
  for (const e of program.edges) {
    if (!byId.has(e.from)) issues.push({ code: 'dangling-ref', edgeId: e.id, message: `边 ${e.id}: 起点节点不存在 "${e.from}"` })
    if (!byId.has(e.to)) issues.push({ code: 'dangling-ref', edgeId: e.id, message: `边 ${e.id}: 终点节点不存在 "${e.to}"` })
  }

  // 1.5) 孤儿/孤岛：从事件入口沿执行边不可达的节点（评审 P2 防刷屏改版）。
  // 链只报链头（无入边者）；入边全来自不可达节点的（互相成环/悬挂环）按弱连通分量合并为一条。
  const outEdges = new Map<string, GEdge[]>()
  for (const e of program.edges) {
    const list = outEdges.get(e.from) ?? []
    list.push(e)
    outEdges.set(e.from, list)
  }
  const reachable = new Set<string>()
  {
    const stack = program.nodes.filter((n) => n.kind === 'on').map((n) => n.id)
    while (stack.length > 0) {
      const id = stack.pop()!
      if (reachable.has(id)) continue
      reachable.add(id)
      for (const e of outEdges.get(id) ?? []) if (!reachable.has(e.to)) stack.push(e.to)
    }
  }
  const unreachableNodes = program.nodes.filter(
    (n) =>
      n.kind !== 'on' &&
      !reachable.has(n.id) &&
      !(n.kind === 'comment' && !program.edges.some((e) => e.to === n.id || e.from === n.id)),
  )
  // 按弱连通分量归组：每组有链头（无入边）→ 只报链头；纯环/悬挂环（互连、无入口）→ 合并一条孤岛
  const memberIds = new Set(unreachableNodes.map((n) => n.id))
  const parent = new Map<string, string>(unreachableNodes.map((n) => [n.id, n.id] as [string, string]))
  const find = (x: string): string => {
    let r = parent.get(x) ?? x
    while (r !== (parent.get(r) ?? r)) r = parent.get(r) ?? r
    return r
  }
  for (const e of program.edges) {
    if (!memberIds.has(e.from) || !memberIds.has(e.to)) continue
    const ra = find(e.from)
    const rb = find(e.to)
    if (ra !== rb) parent.set(ra, rb)
  }
  const groups = new Map<string, GNode[]>()
  for (const node of unreachableNodes) {
    const root = find(node.id)
    const list = groups.get(root) ?? []
    list.push(node)
    groups.set(root, list)
  }
  for (const members of groups.values()) {
    const heads = members.filter((n) => !program.edges.some((e) => e.to === n.id))
    if (heads.length > 0) {
      for (const node of heads) {
        issues.push({
          code: 'structure',
          nodeId: node.id,
          message: `节点 ${node.id}(${node.kind}) 没有任何入边——执行流到不了这里（从事件节点连一条线过来）`,
        })
      }
    } else {
      issues.push({
        code: 'structure',
        nodeId: members[0].id,
        message: `节点 ${members.map((n) => n.id).join('、')} 构成无入口的执行流孤岛（互相连接但没有事件流进来——检查与事件节点的连线）`,
      })
    }
  }

  // 2) 端口协议：branch/loop 出边必须带 true/false 端口，其余节点不得带；(from, port) 唯一
  const portSeen = new Set<string>()
  for (const e of program.edges) {
    const from = byId.get(e.from)
    if (!from) continue
    const needsPort = from.kind === 'branch' || from.kind === 'loop'
    if (needsPort && e.port !== 'true' && e.port !== 'false') {
      issues.push({ code: 'port', edgeId: e.id, nodeId: e.from, message: `边 ${e.id}: ${from.kind} 节点的出边缺少 true/false 端口` })
      continue
    }
    if (!needsPort && e.port !== undefined) {
      issues.push({ code: 'port', edgeId: e.id, nodeId: e.from, message: `边 ${e.id}: ${from.kind} 节点的出边不应带端口` })
      continue
    }
    const key = `${e.from}|${e.port ?? ''}`
    if (portSeen.has(key)) {
      issues.push({ code: 'duplicate-edge', edgeId: e.id, nodeId: e.from, message: `边 ${e.id}: 节点 ${e.from} 的同端口出边重复（执行流只能有一条）` })
    }
    portSeen.add(key)
  }

  // 3) 表达式语法：只收集解析期错误；作用域/类型错误（如空作用域下的「未知属性」）属运行时
  const SYNTAX_RE = /未闭合|无法识别|期望|意外|多余内容|嵌套过深|过长|键应为标识符|禁止属性名/
  for (const node of program.nodes) {
    for (const [field, src] of exprTexts(node)) {
      try {
        evalExpr(src, { event: {}, q: null, v: {} })
      } catch (err) {
        if (!(err instanceof ExprError)) {
          // 求值器之外的异常（实现缺陷或坏数据），如实上报
          issues.push({ code: 'syntax', nodeId: node.id, field, message: `节点 ${node.id}(${node.kind}) ${field}: ${err instanceof Error ? err.message : String(err)}` })
        } else if (SYNTAX_RE.test(err.message)) {
          issues.push({ code: 'syntax', nodeId: node.id, field, message: `节点 ${node.id}(${node.kind}) ${field}: ${err.message}` })
        }
      }
    }
  }

  // 4) 引用检查：on/emit 事件名、实例存在性、level 方法、变量声明（赋值目标 + 表达式 v.* 引用）
  const checkCompRef = (cid: string, where: string, nodeId: string, field?: string): void => {
    if (cid === 'level') return
    if (compIds && !compIds.has(cid)) {
      issues.push({ code: 'dangling-ref', nodeId, field, message: `${where}: 引用不存在的实例 "${cid}"` })
    }
  }
  for (const node of program.nodes) {
    const where = `节点 ${node.id}(${node.kind})`
    switch (node.kind) {
      case 'on':
        if (typeof node.event === 'string' && !EVENT_RE.test(node.event)) {
          issues.push({ code: 'structure', nodeId: node.id, field: 'event', message: `${where}: 非法事件名 "${node.event}"` })
        }
        if (program.edges.some((e) => e.to === node.id)) {
          issues.push({ code: 'structure', nodeId: node.id, message: `${where}: 事件入口节点不能有入边` })
        }
        break
      case 'assign': {
        if (typeof node.target === 'string' && node.target && !declaredVars.has(node.target)) {
          issues.push({
            code: 'undeclared-var',
            nodeId: node.id,
            field: 'target',
            message: `${where}: 赋值未声明变量 "${node.target}"（请在 variables 中声明，或由题目 logicPatch.variables 提供）`,
          })
        }
        if (node.value && typeof node.value === 'object' && 'call' in node.value) {
          checkCompRef(node.value.call.target, where, node.id, 'value')
        }
        break
      }
      case 'call': {
        if (node.target === 'level') {
          if (!(LEVEL_METHODS as readonly string[]).includes(node.method)) {
            issues.push({
              code: 'dangling-ref',
              nodeId: node.id,
              field: 'method',
              message: `${where}: level 没有 "${node.method}" 方法（可用: ${LEVEL_METHODS.join('/')}；换行请用 question.next 或赋值 v.${ROW_POINTER_VAR}）`,
            })
          }
          break
        }
        if (node.target === 'question') {
          if (!(QUESTION_METHODS as readonly string[]).includes(node.method)) {
            issues.push({
              code: 'dangling-ref',
              nodeId: node.id,
              field: 'method',
              message: `${where}: question 没有 "${node.method}" 方法（可用: ${QUESTION_METHODS.join('/')}）`,
            })
          }
          break
        }
        if (node.target === 'views') {
          if (!(VIEWS_METHODS as readonly string[]).includes(node.method)) {
            issues.push({
              code: 'dangling-ref',
              nodeId: node.id,
              field: 'method',
              message: `${where}: views 没有 "${node.method}" 方法（可用: ${VIEWS_METHODS.join('/')}）`,
            })
            break
          }
          // goto 的视图 id：支持字符串字面量与 {id: '...'} 对象字面量两种写法；字面量可校验存在性
          const raw = node.args?.[0]
          const text = typeof raw === 'string' ? raw.trim() : ''
          const bare = /^["']([^"']+)["']$/.exec(text)
          const obj = /^\{\s*id\s*:\s*["']([^"']+)["']\s*\}$/.exec(text)
          const id = bare?.[1] ?? obj?.[1] ?? null
          if (id === null) {
            issues.push({
              code: 'structure',
              nodeId: node.id,
              field: 'args',
              message: `${where}: views.goto 需要视图 id（字符串或 {id: '…'} 字面量；动态表达式仅运行时校验）`,
            })
          } else if (viewIdSet && !viewIdSet.has(id)) {
            issues.push({
              code: 'dangling-ref',
              nodeId: node.id,
              field: 'args',
              message: `${where}: views.goto 指向不存在的视图 "${id}"`,
            })
          }
          break
        }
        checkCompRef(node.target, where, node.id, 'target')
        break
      }
      case 'emit':
        if (typeof node.event === 'string' && (!EVENT_RE.test(node.event) || !node.event.includes(':'))) {
          issues.push({
            code: 'structure',
            nodeId: node.id,
            field: 'event',
            message: `${where}: emit 只能触发内部事件（格式 名字:名字）`,
          })
        }
        break
      default:
        break
    }
    // 表达式中的 v.* 引用扫描（字符串字面量内可能出现假阳性，提示性质）
    for (const [field, src] of exprTexts(node)) {
      for (const m of src.matchAll(VAR_REF_RE)) {
        if (!declaredVars.has(m[1])) {
          issues.push({
            code: 'undeclared-var',
            nodeId: node.id,
            field,
            message: `${where} ${field}: 表达式引用未声明变量 "${m[1]}"（请在 variables 中声明）`,
          })
        }
      }
    }
  }

  // 5) emit 触发环（emit → on(事件) 沿执行边的三色可达性）
  const onsByEvent = new Map<string, GNode[]>()
  for (const node of program.nodes) {
    if (node.kind === 'on' && typeof node.event === 'string') {
      const list = onsByEvent.get(node.event) ?? []
      list.push(node)
      onsByEvent.set(node.event, list)
    }
  }
  const state = new Map<string, 1 | 2>()
  const visit = (id: string, path: string[]): void => {
    state.set(id, 1)
    const node = byId.get(id)
    if (node?.kind === 'emit' && typeof node.event === 'string') {
      for (const entry of onsByEvent.get(node.event) ?? []) {
        if (state.get(entry.id) === 1) {
          issues.push({
            code: 'emit-cycle',
            nodeId: node.id,
            message: `emit 触发环: ${path.concat(node.id).join(' → ')} → ${entry.id}（运行时会被级联预算拦截，应修正逻辑）`,
          })
          continue
        }
        if (!state.has(entry.id)) visit(entry.id, path.concat(node.id))
      }
    }
    for (const e of outEdges.get(id) ?? []) {
      if (state.get(e.to) === 1) continue
      if (!state.has(e.to)) visit(e.to, path)
    }
    state.set(id, 2)
  }
  for (const node of program.nodes) if (!state.has(node.id)) visit(node.id, [node.id])

  return issues
}

/** 装载管线/测试用字符串消息列表 */
export function lintGraphProgram(program: GraphProgram, ctx?: GraphLintCtx): string[] {
  return lintGraphProgramDetailed(program, ctx).map((i) => i.message)
}
