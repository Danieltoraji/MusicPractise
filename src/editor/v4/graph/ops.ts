/**
 * v4 图工作台纯函数操作（docs/53 §13.4）：节点增删改 / 连线 / 移动 / 变量声明 / 自动布局。
 *
 * 纪律与 docStateV4 一致：**恒返回新对象**（结构共享：只复制 nodes/edges/var 数组），
 * 非法操作抛中文错误（GraphWorkbench 捕获后显示在错误条，不写坏文档）。
 * 端口协议按 docs/53 §6/§7：branch/loop/foreach = true/false 双出口，其余单出口；
 * start/on 无入边，return/restart/comment 无出边（comment 不参与执行、完全不可接线）。
 */
import type {
  BehaviorNode,
  BehaviorProgram,
  FlowNode,
  FlowProgram,
  GraphEdge,
  StateFieldDef,
  StateType,
} from '../../../engine/v4/model'
import { newUniqueLocalId } from '../../../engine/v4/model'
import { arrangePositions, type ArrangeMode } from './layout'

export type GraphLayer = 'flow' | 'behavior'
export type AnyGraphNode = FlowNode | BehaviorNode
export type AnyGraphProgram = FlowProgram | BehaviorProgram

export interface GraphProgramView<N extends AnyGraphNode = AnyGraphNode> {
  nodes: N[]
  edges: GraphEdge[]
}

const NODE_ID_PREFIX: Record<string, string> = {
  start: 'start',
  assign: 'assign',
  call: 'call',
  setView: 'setview',
  ask: 'ask',
  foreach: 'foreach',
  branch: 'branch',
  loop: 'loop',
  wait: 'wait',
  waitShell: 'waitshell',
  finish: 'finish',
  restart: 'restart',
  comment: 'comment',
  on: 'on',
  return: 'ret',
  emit: 'emit',
}

/** 生成唯一节点 id（程序化、形态合法；不使用手抄 id） */
export function newNodeId(kind: AnyGraphNode['kind'], existing: Iterable<string>): string {
  return newUniqueLocalId(NODE_ID_PREFIX[kind] ?? 'node', existing)
}

export function newEdgeId(existing: Iterable<string>): string {
  return newUniqueLocalId('edge', existing)
}

/** 双出口节点（true=体/真，false=出口/假） */
export function isDualPortKind(kind: AnyGraphNode['kind']): boolean {
  return kind === 'branch' || kind === 'loop' || kind === 'foreach'
}

/** 可被接入的节点（入口节点不允许有入边） */
export function canAcceptInput(kind: AnyGraphNode['kind']): boolean {
  return kind !== 'start' && kind !== 'on' && kind !== 'comment'
}

/** 有出边的节点（注释不参与执行、return/restart 是结束点） */
export function hasOutput(kind: AnyGraphNode['kind']): boolean {
  return kind !== 'return' && kind !== 'restart' && kind !== 'comment'
}

/** React Flow sourceHandle → IR 端口：'true'/'false' → 对应端口；'out'/null → 单出口 */
export function portFromHandle(handle: string | null | undefined): 'true' | 'false' | undefined {
  return handle === 'true' || handle === 'false' ? handle : undefined
}

/** 新增节点（id 必须唯一；不自动接线——接线由作者拖端口或检查器完成） */
export function addNode<P extends AnyGraphProgram>(program: P, node: AnyGraphNode): P {
  if (program.nodes.some((existing) => existing.id === node.id)) {
    throw new Error(`节点 id「${node.id}」已存在，无法添加`)
  }
  return { ...program, nodes: [...program.nodes, node] } as unknown as P
}

export interface NodePatch {
  [key: string]: unknown
}

/** 修改节点字段（浅合并；undefined = 删除可选字段；不改 id/kind；无变化返回入参引用） */
export function updateNode<P extends AnyGraphProgram>(program: P, nodeId: string, patch: NodePatch): P {
  const index = program.nodes.findIndex((node) => node.id === nodeId)
  if (index < 0) return program
  const current = program.nodes[index] as unknown as Record<string, unknown>
  const next: Record<string, unknown> = { ...current }
  let changed = false
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'id' || key === 'kind') continue
    if (value === undefined) {
      if (key in next) {
        delete next[key]
        changed = true
      }
    } else if (JSON.stringify(next[key]) !== JSON.stringify(value)) {
      next[key] = value
      changed = true
    }
  }
  if (!changed) return program
  const nodes = program.nodes.slice()
  nodes[index] = next as unknown as AnyGraphNode
  return { ...program, nodes } as unknown as P
}

/** 删除节点（级联删除其所有出边/入边） */
export function removeNode<P extends AnyGraphProgram>(program: P, nodeId: string): P {
  if (!program.nodes.some((node) => node.id === nodeId)) return program
  return {
    ...program,
    nodes: program.nodes.filter((node) => node.id !== nodeId),
    edges: program.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
  } as unknown as P
}

/** 拖拽落点写回 IR（x/y 取整；坐标未变返回入参引用） */
export function moveNode<P extends AnyGraphProgram>(program: P, nodeId: string, x: number, y: number): P {
  const roundedX = Math.round(x)
  const roundedY = Math.round(y)
  const node = program.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return program
  if (node.x === roundedX && node.y === roundedY) return program
  return updateNode(program, nodeId, { x: roundedX, y: roundedY })
}

/** 删除连线（不存在返回入参引用） */
export function removeEdge<P extends AnyGraphProgram>(program: P, edgeId: string): P {
  if (!program.edges.some((edge) => edge.id === edgeId)) return program
  return { ...program, edges: program.edges.filter((edge) => edge.id !== edgeId) } as unknown as P
}

/**
 * 连线（React Flow onConnect / 检查器「接到下一节点」共用）：
 * 宽松错误文案（中文）直接展示在画布错误条；成功返回新 program。
 */
export function connectNodes<P extends AnyGraphProgram>(
  program: P,
  from: string,
  to: string,
  port?: 'true' | 'false',
): P {
  const source = program.nodes.find((node) => node.id === from)
  const target = program.nodes.find((node) => node.id === to)
  if (!source) throw new Error(`连线起点「${from}」不存在`)
  if (!target) throw new Error(`连线终点「${to}」不存在`)
  if (source.kind === 'comment') throw new Error('注释节点不参与执行，不能接线')
  if (target.kind === 'comment') throw new Error('注释节点不参与执行，不能接收连线')
  if (from === to) throw new Error(`不能把节点「${from}」接到自己（会形成自环）`)
  if (!hasOutput(source.kind)) {
    throw new Error(`节点「${source.kind}」是结束点，没有出口，不能接线`)
  }
  if (!canAcceptInput(target.kind)) {
    throw new Error(`节点「${target.kind}」是入口节点，不能有入边`)
  }
  const dual = isDualPortKind(source.kind)
  if (dual && port === undefined) {
    throw new Error(`节点「${source.kind}」有真/假两个出口，连线必须从真或假端口拖出`)
  }
  if (!dual && port !== undefined) {
    throw new Error(`节点「${source.kind}」只有一个出口，不能指定真/假端口`)
  }
  const duplicated = program.edges.some((edge) => edge.from === from && edge.port === port)
  if (duplicated) {
    throw new Error(
      dual
        ? `节点「${from}」的${port === 'true' ? '真（true）' : '假（false）'}出口已经有一条连线，每个出口最多一条`
        : `节点「${from}」的出口已经有一条连线，请先删除旧连线`,
    )
  }
  const edge: GraphEdge = { id: newEdgeId(program.edges.map((candidate) => candidate.id)), from, to }
  if (port !== undefined) edge.port = port
  return { ...program, edges: [...program.edges, edge] } as unknown as P
}

/** 修改连线端口（检查器/键盘重接用；collision 同 connectNodes 规则） */
export function rewireEdge<P extends AnyGraphProgram>(program: P, edgeId: string, to: string, port?: 'true' | 'false'): P {
  const edge = program.edges.find((candidate) => candidate.id === edgeId)
  if (!edge) throw new Error(`连线「${edgeId}」不存在`)
  const withoutEdge = removeEdge(program, edgeId)
  return connectNodes(withoutEdge, edge.from, to, port)
}

// ---------------------------------------------------------------------------
// 变量声明（flow.vars / behavior.locals）
// ---------------------------------------------------------------------------

export function programDeclarations(program: AnyGraphProgram): StateFieldDef[] {
  return program.kind === 'flow' ? (program.vars ?? []) : (program.locals ?? [])
}

function withDeclarations<P extends AnyGraphProgram>(program: P, fields: StateFieldDef[]): P {
  if (program.kind === 'flow') return { ...program, vars: fields } as unknown as P
  return { ...program, locals: fields } as unknown as P
}

/** 新增变量声明（key 程序化生成 `var1`/`local1` 递增，避免手抄；返回新 key 供检查器聚焦） */
export function addDeclaration<P extends AnyGraphProgram>(
  program: P,
  init: { type?: StateType; value?: unknown } = {},
): { program: P; key: string } {
  const fields = programDeclarations(program)
  const prefix = program.kind === 'flow' ? 'var' : 'local'
  const used = new Set(fields.map((field) => field.key))
  let index = 1
  while (used.has(`${prefix}${index}`)) index += 1
  const key = `${prefix}${index}`
  const field: StateFieldDef = {
    key,
    type: init.type ?? 'number',
    init: (init.value ?? 0) as StateFieldDef['init'],
  }
  return { program: withDeclarations(program, [...fields, field]), key }
}

/** 更新变量声明（key 不可改——表达式引用与重命名开销留给 JSON/AI 层） */
export function updateDeclaration<P extends AnyGraphProgram>(
  program: P,
  key: string,
  patch: Partial<Omit<StateFieldDef, 'key'>>,
): P {
  const fields = programDeclarations(program)
  const index = fields.findIndex((field) => field.key === key)
  if (index < 0) return program
  const current = fields[index]
  const next: StateFieldDef = { ...current }
  if (patch.type !== undefined) next.type = patch.type
  if (patch.init !== undefined) next.init = patch.init as StateFieldDef['init']
  if (next.type === current.type && JSON.stringify(next.init) === JSON.stringify(current.init)) return program
  const out = fields.slice()
  out[index] = next
  return withDeclarations(program, out)
}

/** 删除变量声明（引用它的表达式由 lint 标红提示） */
export function removeDeclaration<P extends AnyGraphProgram>(program: P, key: string): P {
  const fields = programDeclarations(program)
  if (!fields.some((field) => field.key === key)) return program
  return withDeclarations(
    program,
    fields.filter((field) => field.key !== key),
  )
}

// ---------------------------------------------------------------------------
// 自动布局
// ---------------------------------------------------------------------------

export function arrangeProgram<P extends AnyGraphProgram>(program: P, mode: ArrangeMode): P {
  return arrangePositions(program, mode)
}
