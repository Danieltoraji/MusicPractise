/**
 * 预设 / 零代码模板共用的纯函数装配工具（无 React、无副作用）。
 *
 * - `mergePresetResult`：把 build 产物并入层程序（校验 id 冲突/悬空/端口协议）；
 * - `connectProgramNodes`：给模板/调用方补外接边（校验入口/终止/端口规则）；
 * - `applyPresetResultToDoc`：层程序级装配（结构共享，返回新 doc）；
 * - `presetDeclarations`：flow 预设依赖的 run 变量声明（供模板/接入方自动补齐）。
 */
import type {
  BehaviorProgram,
  FlowProgram,
  GraphEdge,
  LevelDocV4,
  StateFieldDef,
} from '../model'
import { isV4LocalId } from '../model'
import type { PresetBuildResult, PresetLayer } from './types'

type AnyProgram = FlowProgram | BehaviorProgram

const DUAL_PORT_KINDS = new Set(['branch', 'loop', 'foreach'])
const TERMINAL_KINDS = new Set(['return', 'restart'])
const ENTRY_KINDS = new Set(['start', 'on'])

function assertLocalId(id: unknown, what: string): asserts id is string {
  if (typeof id !== 'string' || !isV4LocalId(id)) {
    throw new Error(`${what} id「${String(id)}」形态非法（字母/下划线开头、不含 .、≤64 字符）`)
  }
}

function nodeIdsOf(program: AnyProgram): Set<string> {
  return new Set(program.nodes.map((node) => node.id))
}

/**
 * 把预设展开结果并入层程序：节点/边按顺序追加，返回新对象（结构共享）。
 * 冲突（节点 id/边 id 重复、边端点不在本次展开内、自环）→ 中文错误，不修改入参。
 */
export function mergePresetResult<P extends AnyProgram>(program: P, result: PresetBuildResult): P {
  const existingNodeIds = nodeIdsOf(program)
  const existingEdgeIds = new Set(program.edges.map((edge) => edge.id))
  const newNodeIds = new Set<string>()
  for (const node of result.nodes) {
    assertLocalId(node.id, '预设节点')
    if (existingNodeIds.has(node.id) || newNodeIds.has(node.id)) {
      throw new Error(`预设节点 id「${node.id}」与现有节点冲突，请重新展开预设`)
    }
    newNodeIds.add(node.id)
  }
  const edges: GraphEdge[] = []
  const seenEdgeIds = new Set<string>()
  for (const edge of result.edges) {
    assertLocalId(edge.id, '预设连线')
    if (existingEdgeIds.has(edge.id) || seenEdgeIds.has(edge.id)) {
      throw new Error(`预设连线 id「${edge.id}」重复，请重新展开预设`)
    }
    if (!newNodeIds.has(edge.from) || !newNodeIds.has(edge.to)) {
      throw new Error(`预设连线「${edge.id}」端点不在本次展开的节点组内（${edge.from} → ${edge.to}）`)
    }
    if (edge.from === edge.to) throw new Error(`预设连线「${edge.id}」不能自环`)
    seenEdgeIds.add(edge.id)
    edges.push(edge)
  }
  return {
    ...program,
    nodes: [...program.nodes, ...result.nodes],
    edges: [...program.edges, ...edges],
  } as P
}

/**
 * 给程序补一条外接边（模板把 `start → 预设入口`、或把预设入口接到上游链尾时用）。
 * 校验与图工作台连线规则一致：入口节点不能有入边、结束点不能有出边、双出口必须给端口、
 * 同一 (from, port) 最多一条。边 id 程序化生成（`pe_<n>` 查重）。
 */
export function connectProgramNodes<P extends AnyProgram>(
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
  if (TERMINAL_KINDS.has(source.kind)) throw new Error(`节点「${source.kind}」是结束点，没有出口，不能接线`)
  if (ENTRY_KINDS.has(target.kind)) throw new Error(`节点「${target.kind}」是入口节点，不能有入边`)
  const dual = DUAL_PORT_KINDS.has(source.kind)
  if (dual && port === undefined) throw new Error(`节点「${source.kind}」有真/假两个出口，连线必须指定端口`)
  if (!dual && port !== undefined) throw new Error(`节点「${source.kind}」只有一个出口，不能指定真/假端口`)
  if (program.edges.some((edge) => edge.from === from && edge.port === port)) {
    throw new Error(`节点「${from}」的${port === undefined ? '' : port === 'true' ? '真' : '假'}出口已经有一条连线`)
  }
  const used = new Set(program.edges.map((edge) => edge.id))
  let index = 1
  while (used.has(`pe_${index}`)) index += 1
  const edge: GraphEdge = { id: `pe_${index}`, from, to }
  if (port !== undefined) edge.port = port
  return { ...program, edges: [...program.edges, edge] } as P
}

/** 把预设产物装配进文档对应层（结构共享：只复制 doc→content→目标层分支） */
export function applyPresetResultToDoc(
  doc: LevelDocV4,
  layer: PresetLayer,
  typeId: string | undefined,
  result: PresetBuildResult,
): LevelDocV4 {
  if (layer === 'flow') {
    return {
      ...doc,
      content: { ...doc.content, flow: mergePresetResult(doc.content.flow, result) },
    }
  }
  if (typeId === undefined || typeId === '') throw new Error('行为预设需要题型 id（typeId）')
  let found = false
  const types = doc.content.types.map((type) => {
    if (type.id !== typeId) return type
    found = true
    return { ...type, behavior: mergePresetResult(type.behavior, result) }
  })
  if (!found) throw new Error(`题型「${typeId}」不存在，无法装配行为预设`)
  return { ...doc, content: { ...doc.content, types } }
}

/** 一个 run 变量声明（v.*） */
function numberVar(key: string): StateFieldDef {
  return { key, type: 'number', init: 0 }
}

/**
 * flow 预设依赖的 run 变量声明（供模板/接入方自动补齐；已有同 key 声明时调用方应跳过）。
 * behavior 预设不写 v.*，返回空数组。
 */
export function presetDeclarations(presetId: string, params: Record<string, unknown> = {}): StateFieldDef[] {
  const updateRow = typeof params.updateRow === 'string' ? params.updateRow : 'yes'
  switch (presetId) {
    case 'sequence-grade-settle':
    case 'retry-n':
      return updateRow === 'no' ? [numberVar('score')] : [numberVar('score'), numberVar('row')]
    case 'unlock-branch':
    case 'settle-then-replay':
      return [numberVar('score')]
    default:
      return []
  }
}
