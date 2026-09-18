/**
 * ECA（LogicProgram v1）→ GraphProgram v2 的迁移编译器。
 *
 * 映射规则（docs/12 §10）：
 * - Rule.on → on 节点；when[] 全部 AND → branch（每项加括号保优先级）
 * - do / else 动作序列 → 沿执行边的节点链（true / false 端口）
 * - 无 when 的规则：else 在 ECA 语义下是永不执行的死代码，迁移时丢弃（行为等价）
 * - Json 参数 → expr 文本（jsonToExpr）：$ 引用去前缀、标量/数组/对象转字面量
 * - call 参数列表当前取首参作为命令 args（契约 v2 的 command 方法为 0/1 参，与现状 dispatchCommand 对齐）
 */

import type { Json } from './expr'
import type { Action, LogicProgram, Rule } from './logic'
import type { GEdge, GNode, GraphProgram } from './graphProgram'

const REF_RE = /^\$(q|event|v)(\.[A-Za-z_][A-Za-z0-9_]*)+$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 字符串字面量：单引号包裹，按 expr 词法转义（script.ts 的生成器复用） */
export function exprStringLiteral(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}'`
}
const strLit = exprStringLiteral

/** ECA 动作参数（Json）→ expr 源文本。$q/$v/$event 引用去前缀，$expr: 去前缀，其余为字面量。 */
export function jsonToExpr(value: Json): string {
  if (typeof value === 'string') {
    if (value.startsWith('$expr:')) return value.slice(6)
    if (REF_RE.test(value)) return value.slice(1)
    return strLit(value)
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(jsonToExpr).join(', ')}]`
  const entries = Object.entries(value)
  for (const [k] of entries) {
    if (!IDENT_RE.test(k)) throw new Error(`迁移失败：对象键 "${k}" 不是标识符，无法转为表达式对象字面量`)
  }
  return `{${entries.map(([k, v]) => `${k}: ${jsonToExpr(v as Json)}`).join(', ')}}`
}

function actionToNode(ruleId: string, phase: 'd' | 'e', i: number, action: Action): GNode {
  const id = `${ruleId}_${phase}${i}`
  // 判定顺序与引擎一致：set → emit → cmd（set 动作同时含 expr 键）
  if ('set' in action) {
    return { id, kind: 'assign', target: action.set, value: { expr: action.expr } }
  }
  if ('emit' in action) {
    const node: GNode = { id, kind: 'emit', event: action.emit }
    if (action.payload !== undefined) {
      const p = action.payload
      if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
        node.payload = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, jsonToExpr(v as Json)]))
      } else {
        // 非对象 payload 极罕见：包装进 value 键（形状变化在 golden 测试中可见）
        node.payload = { value: jsonToExpr(p) }
      }
    }
    return node
  }
  const parts = action.cmd.split('.')
  if (parts.length !== 2) throw new Error(`迁移失败：非法命令路径 "${action.cmd}"`)
  return {
    id,
    kind: 'call',
    target: parts[0],
    method: parts[1],
    args: action.args === undefined ? [] : [jsonToExpr(action.args)],
  }
}

export function migrateLogicV1toV2(program: LogicProgram): GraphProgram {
  const nodes: GNode[] = []
  const edges: GEdge[] = []
  let edgeSeq = 0
  const link = (from: string, to: string, port?: 'true' | 'false'): void => {
    edges.push(port ? { id: `m${++edgeSeq}`, from, to, port } : { id: `m${++edgeSeq}`, from, to })
  }
  const seenRuleIds = new Set<string>()

  const actionChain = (ruleId: string, phase: 'd' | 'e', actions: Action[]): { head?: string } => {
    let head: string | undefined
    let tail: string | undefined
    actions.forEach((a, i) => {
      const node = actionToNode(ruleId, phase, i, a)
      nodes.push(node)
      if (tail) link(tail, node.id)
      head ??= node.id
      tail = node.id
    })
    return { head }
  }

  for (const rule of program.rules) {
    migrateRule(rule, nodes, link, actionChain, seenRuleIds)
  }

  return {
    logicVersion: 2,
    variables: structuredClone(program.variables ?? {}),
    nodes,
    edges,
  }
}

function migrateRule(
  rule: Rule,
  nodes: GNode[],
  link: (from: string, to: string, port?: 'true' | 'false') => void,
  actionChain: (ruleId: string, phase: 'd' | 'e', actions: Action[]) => { head?: string },
  seenRuleIds: Set<string>,
): void {
  if (seenRuleIds.has(rule.id)) throw new Error(`迁移失败：规则 id 重复 "${rule.id}"`)
  seenRuleIds.add(rule.id)

  const onId = `${rule.id}_on`
  nodes.push({ id: onId, kind: 'on', event: rule.on })

  const whens = rule.when ?? []
  if (whens.length === 0) {
    // 无 when：else 在 ECA 下永不执行（死代码），丢弃，do 直连
    const { head } = actionChain(rule.id, 'd', rule.do)
    if (head) link(onId, head)
    return
  }
  const branchId = `${rule.id}_cond`
  nodes.push({ id: branchId, kind: 'branch', cond: whens.map((w) => `(${w})`).join(' && ') })
  link(onId, branchId)
  const doHead = actionChain(rule.id, 'd', rule.do).head
  if (doHead) link(branchId, doHead, 'true')
  const elseHead = actionChain(rule.id, 'e', rule.else ?? []).head
  if (elseHead) link(branchId, elseHead, 'false')
}
