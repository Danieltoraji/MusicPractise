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
import { evalExpr } from './expr'

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

/** level facade 暴露给逻辑的方法（伪实例 id = "level"） */
export const LEVEL_METHODS = ['next', 'restart', 'finish'] as const

/** 判定一段未知 JSON 是否为 GraphProgram（装载/导入管线用） */
export function isGraphProgram(x: unknown): x is GraphProgram {
  if (x === null || typeof x !== 'object') return false
  const p = x as Record<string, unknown>
  return p.logicVersion === 2 && Array.isArray(p.nodes) && Array.isArray(p.edges)
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
export function updateNode(prog: GraphProgram, id: string, patch: Partial<GNode> & { id?: never }): GraphProgram {
  requireNode(prog, id)
  const next = clone(prog)
  const idx = next.nodes.findIndex((n) => n.id === id)
  next.nodes[idx] = { ...next.nodes[idx], ...patch } as GNode
  return next
}

export function moveNode(prog: GraphProgram, id: string, x: number, y: number): GraphProgram {
  return updateNode(prog, id, { x, y } as Partial<GNode>)
}

/**
 * 连一条执行边。规则：
 * - on/comment 不能作为 to；comment 不能作为 from
 * - branch/loop 出边必须带 port（'true'|'false'），其余节点出边不能带 port
 * - 同一 (from, port) 只保留一条出边，重复连接替换旧边
 * - 允许自环（空循环体等，运行时由节点预算兜底）
 */
export function connect(prog: GraphProgram, from: string, to: string, port?: 'true' | 'false'): GraphProgram {
  const f = requireNode(prog, from)
  const t = requireNode(prog, to)
  if (t.kind === 'on') throw new Error('事件入口节点（on）不能有入边')
  if (f.kind === 'comment' || t.kind === 'comment') throw new Error('注释节点不参与连线')
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
  if (!ID_RE.test(name)) throw new Error(`非法变量名: ${name}`)
  const next = clone(prog)
  next.variables = { ...next.variables, [name]: value }
  return next
}

export function renameGraphVariable(prog: GraphProgram, oldName: string, newName: string): GraphProgram {
  if (!ID_RE.test(newName)) throw new Error(`非法变量名: ${newName}`)
  if (oldName === newName) return prog
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
  const next = clone(prog)
  const vars = { ...(next.variables ?? {}) }
  delete vars[name]
  next.variables = vars
  return next
}

// ---------------------------------------------------------------------------
// 装载期 lint（与 LogicEngine.lint 同风格：返回错误消息列表）
// ---------------------------------------------------------------------------

const EVENT_RE = /^[A-Za-z_][A-Za-z0-9_]*([.:][A-Za-z_][A-Za-z0-9_]*)+$/

/** 收集节点中出现的全部表达式源文本（语法检查用） */
function exprTexts(node: GNode): [string, string][] {
  const out: [string, string][] = []
  const rvalue = (label: string, rv: RValue) => {
    if ('expr' in rv) out.push([label, rv.expr])
    else rv.call.args.forEach((a, i) => out.push([`${label} call 参数[${i}]`, a]))
  }
  switch (node.kind) {
    case 'assign':
      rvalue('value', node.value)
      break
    case 'call':
      node.args.forEach((a, i) => out.push([`args[${i}]`, a]))
      break
    case 'branch':
      out.push(['cond', node.cond])
      break
    case 'loop':
      if (node.cond !== undefined) out.push(['cond', node.cond])
      if (node.times !== undefined) out.push(['times', node.times])
      break
    case 'wait':
      out.push(['ms', node.ms])
      break
    case 'emit':
      for (const [k, v] of Object.entries(node.payload ?? {})) out.push([`payload.${k}`, v])
      break
    default:
      break
  }
  return out
}

/**
 * GraphProgram 装载期校验。
 * ctx.componentIds 提供组件 id 集合时做悬空实例检查；extraVariableKeys 豁免题目 logicPatch 声明的变量。
 * 方法存在性校验（契约 v2）在 3-1 执行器批次接入。
 */
export function lintGraphProgram(
  program: GraphProgram,
  ctx?: { componentIds?: Iterable<string>; extraVariableKeys?: Iterable<string> },
): string[] {
  const errors: string[] = []
  const compIds = ctx?.componentIds ? new Set(ctx.componentIds) : null
  const declaredVars = new Set<string>(ctx?.extraVariableKeys ?? [])
  for (const key of Object.keys(program.variables ?? {})) declaredVars.add(key)

  // 0) 节点 id 唯一性
  const seen = new Set<string>()
  for (const node of program.nodes) {
    if (seen.has(node.id)) errors.push(`节点 id 重复: ${node.id}`)
    seen.add(node.id)
  }
  const byId = new Map(program.nodes.map((n) => [n.id, n]))

  // 1) 边引用完整性
  for (const e of program.edges) {
    if (!byId.has(e.from)) errors.push(`边 ${e.id}: 起点节点不存在 "${e.from}"`)
    if (!byId.has(e.to)) errors.push(`边 ${e.id}: 终点节点不存在 "${e.to}"`)
  }

  // 2) 表达式语法（只收集解析期错误，作用域错误属运行时）
  for (const node of program.nodes) {
    for (const [where, src] of exprTexts(node)) {
      try {
        evalExpr(src, { event: {}, q: null, v: {} })
      } catch (err) {
        if (err instanceof Error && /未闭合|无法识别|期望|意外|多余内容|嵌套过深|过长|键应为标识符|禁止属性名/.test(err.message)) {
          errors.push(`节点 ${node.id}(${node.kind}) ${where}: ${err.message}`)
        }
      }
    }
  }

  // 3) 结构与引用检查
  const checkCompRef = (cid: string, where: string): boolean => {
    if (cid === 'level') return true
    if (compIds && !compIds.has(cid)) {
      errors.push(`${where}: 引用不存在的实例 "${cid}"`)
      return false
    }
    return true
  }
  for (const node of program.nodes) {
    const where = `节点 ${node.id}(${node.kind})`
    switch (node.kind) {
      case 'on':
        if (!EVENT_RE.test(node.event)) errors.push(`${where}: 非法事件名 "${node.event}"`)
        if (program.edges.some((e) => e.to === node.id)) errors.push(`${where}: 事件入口节点不能有入边`)
        break
      case 'assign':
        if (!declaredVars.has(node.target)) {
          errors.push(`${where}: 赋值未声明变量 "${node.target}"（请在 variables 中声明，或由题目 logicPatch.variables 提供）`)
        }
        if ('call' in node.value) checkCompRef(node.value.call.target, where)
        break
      case 'call':
        if (node.target === 'level') {
          if (!(LEVEL_METHODS as readonly string[]).includes(node.method)) {
            errors.push(`${where}: level 没有 "${node.method}" 方法（可用: ${LEVEL_METHODS.join('/')}）`)
          }
        } else {
          checkCompRef(node.target, where)
        }
        break
      case 'emit':
        if (!EVENT_RE.test(node.event) || !node.event.includes(':')) {
          errors.push(`${where}: emit 只能触发内部事件（格式 名字:名字）`)
        }
        break
      case 'branch':
        break
      case 'loop':
        if (node.mode === 'while' && node.cond === undefined) errors.push(`${where}: while 缺少 cond`)
        if (node.mode === 'repeat' && node.times === undefined) errors.push(`${where}: repeat 缺少 times`)
        break
      default:
        break
    }
  }

  // 4) emit 触发环（emit → on(事件) 沿执行边的三色可达性）
  const onsByEvent = new Map<string, GNode[]>()
  for (const node of program.nodes) {
    if (node.kind === 'on') {
      const list = onsByEvent.get(node.event) ?? []
      list.push(node)
      onsByEvent.set(node.event, list)
    }
  }
  const outEdges = new Map<string, GEdge[]>()
  for (const e of program.edges) {
    const list = outEdges.get(e.from) ?? []
    list.push(e)
    outEdges.set(e.from, list)
  }
  const state = new Map<string, 1 | 2>()
  const visit = (id: string, path: string[]): void => {
    state.set(id, 1)
    const node = byId.get(id)
    if (node?.kind === 'emit') {
      for (const entry of onsByEvent.get(node.event) ?? []) {
        if (state.get(entry.id) === 1) {
          errors.push(`emit 触发环: ${path.concat(node.id).join(' → ')} → ${entry.id}（运行时会被级联预算拦截，应修正逻辑）`)
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

  return errors
}
