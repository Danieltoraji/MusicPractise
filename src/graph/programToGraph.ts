/**
 * LogicProgram → 只读节点图的结构转换（纯函数，无布局/React 依赖）。
 * 节点：事件入口 / 规则 / 动作 / 变量；边：触发(emit→事件, 虚线)、写入(set→变量)、读取(表达式引用变量, 虚线)。
 * 布局（dagre 分层）由 LogicGraph 视图层负责。
 */
import type { LogicProgram, Action } from '../engine/logic'

export type GraphNodeKind = 'event' | 'rule' | 'action' | 'var'

export interface GraphNodeData {
  kind: GraphNodeKind
  label: string
  sub?: string
}

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  label: string
  sub?: string
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: 'flow' | 'trigger' | 'write' | 'read'
  label?: string
}

export interface ProgramGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const actionLabel = (a: Action): { label: string; sub?: string } => {
  if ('cmd' in a) {
    const args = a.args && Object.keys(a.args).length > 0 ? ` (${JSON.stringify(a.args)})` : ''
    return { label: `⚙ ${a.cmd}${args}` }
  }
  if ('set' in a) return { label: `✎ ${a.set} = ${a.expr}` }
  return { label: `⚡ emit ${a.emit}` }
}

/** 提取表达式中读取的变量名（v.xxx） */
export function exprReadVars(expr: string): string[] {
  const out: string[] = []
  const re = /\bv\.([A-Za-z_]\w*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(expr)) !== null) out.push(m[1])
  return out
}

/** 动作参数与 emit payload 中的 $v./v. 引用（简化：扫 $v. 前缀） */
function actionReadVars(a: Action): string[] {
  const out: string[] = []
  const scan = (v: unknown): void => {
    if (typeof v === 'string') {
      let m: RegExpExecArray | null
      const re = /\$v\.([A-Za-z_]\w*)/g
      while ((m = re.exec(v)) !== null) out.push(m[1])
    } else if (Array.isArray(v)) v.forEach(scan)
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(scan)
  }
  if ('cmd' in a && a.args !== undefined) scan(a.args)
  if ('set' in a && a.expr !== undefined) out.push(...exprReadVars(a.expr))
  if ('emit' in a && a.payload !== undefined) scan(a.payload)
  return out
}

export function programToGraph(program: LogicProgram): ProgramGraph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const seenEdges = new Set<string>()
  const addEdge = (e: Omit<GraphEdge, 'id'>): void => {
    const id = `${e.source}->${e.target}:${e.kind}`
    if (seenEdges.has(id)) return
    seenEdges.add(id)
    edges.push({ id, ...e })
  }

  const variables = program.variables ?? {}
  const varIds = new Set<string>()
  for (const [name, value] of Object.entries(variables)) {
    const id = `var:${name}`
    varIds.add(id)
    nodes.push({ id, kind: 'var', label: `v.${name}`, sub: `= ${JSON.stringify(value)}` })
  }

  // 事件入口节点（去重）
  const eventIds = new Set<string>()
  for (const rule of program.rules) {
    if (!eventIds.has(rule.on)) {
      eventIds.add(rule.on)
      nodes.push({ id: `event:${rule.on}`, kind: 'event', label: `⚡ ${rule.on}` })
    }
  }

  for (const rule of program.rules) {
    const ruleId = `rule:${rule.id}`
    nodes.push({
      id: ruleId,
      kind: 'rule',
      label: `规则 ${rule.id}`,
      sub: (rule.when ?? []).length > 0 ? `条件 ×${rule.when!.length}` : undefined,
    })
    addEdge({ source: `event:${rule.on}`, target: ruleId, kind: 'flow' })

    // 条件读取的变量 → 数据依赖边
    for (const w of rule.when ?? []) {
      for (const v of exprReadVars(w)) {
        if (varIds.has(`var:${v}`)) addEdge({ source: `var:${v}`, target: ruleId, kind: 'read', label: '读取' })
      }
    }

    rule.do.forEach((a, i) => {
      const aid = `action:${rule.id}:${i}`
      const { label, sub } = actionLabel(a)
      nodes.push({ id: aid, kind: 'action', label, sub })
      addEdge({ source: ruleId, target: aid, kind: 'flow' })
      if ('set' in a && varIds.has(`var:${a.set}`)) {
        addEdge({ source: aid, target: `var:${a.set}`, kind: 'write', label: '写入' })
      }
      // 表达式读取的变量 → 数据依赖边
      for (const v of actionReadVars(a)) {
        if (varIds.has(`var:${v}`)) addEdge({ source: `var:${v}`, target: aid, kind: 'read', label: '读取' })
      }
      if ('emit' in a) {
        // 触发边：指向被该事件点亮的事件节点（若存在）
        if (eventIds.has(a.emit) || program.rules.some((r) => r.on === a.emit)) {
          addEdge({ source: aid, target: `event:${a.emit}`, kind: 'trigger', label: '触发' })
        }
      }
    })

    if (rule.else) {
      rule.else.forEach((a, i) => {
        const aid = `action:${rule.id}:else:${i}`
        const { label, sub } = actionLabel(a)
        nodes.push({ id: aid, kind: 'action', label, sub })
        addEdge({ source: ruleId, target: aid, kind: 'flow', label: '否则' })
        if ('set' in a && varIds.has(`var:${a.set}`)) {
          addEdge({ source: aid, target: `var:${a.set}`, kind: 'write', label: '写入' })
        }
        for (const v of actionReadVars(a)) {
          if (varIds.has(`var:${v}`)) addEdge({ source: `var:${v}`, target: aid, kind: 'read', label: '读取' })
        }
      })
    }
  }

  // 未被任何规则/动作引用的变量节点不产生悬空边，仅保留节点
  return { nodes, edges }
}
