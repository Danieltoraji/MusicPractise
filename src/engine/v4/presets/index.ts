/**
 * v4 预设目录入口（docs/53 §14）：
 * - `PresetDef` / 参数定义（types.ts 再导出）；
 * - `PRESET_CATALOG`：flow 4 个 + behavior 7 个内置预设；
 * - `buildPreset(id, ctx, params)`：展开成**普通节点 + 边 + comment**（结构自检后返回）；
 * - `presetDefaults` / `normalizePresetParams`：参数默认值与类型/选项归一化（画廊表单复用）；
 * - `insertPresetIntoDoc`：文档级装配（含 flow 变量声明自动补齐，模板/AI/接入方可直接用）。
 *
 * 约束：本模块是纯函数（不依赖 runtime/React）；不写运行期策略元数据；不隐藏行为。
 */
import type { Json } from '../../expr'
import type { LevelDocV4, StateFieldDef } from '../model'
import { isV4LocalId } from '../model'
import { BEHAVIOR_PRESETS } from './behavior'
import { FLOW_PRESETS } from './flow'
import {
  applyPresetResultToDoc,
  presetDeclarations,
} from './insert'
import type { PresetBuildResult, PresetCtx, PresetDef, PresetLayer, PresetParamDef } from './types'

export type { PresetBuildResult, PresetCtx, PresetDef, PresetLayer, PresetParamDef, PresetParamOption, PresetParamType } from './types'
export { BEHAVIOR_PRESETS } from './behavior'
export { FLOW_PRESETS } from './flow'
export { applyPresetResultToDoc, connectProgramNodes, mergePresetResult, presetDeclarations } from './insert'

/** 全部内置预设（flow 在前；`PRESET_CATALOG` 的 id 必须全局唯一） */
export const PRESET_CATALOG: PresetDef[] = [...FLOW_PRESETS, ...BEHAVIOR_PRESETS]

/** 按层筛选（画廊/工具列表用） */
export function presetsByLayer(layer: PresetLayer): PresetDef[] {
  return PRESET_CATALOG.filter((preset) => preset.layer === layer)
}

/** 按 id 取预设（未知 id 返回 undefined） */
export function getPreset(id: string): PresetDef | undefined {
  return PRESET_CATALOG.find((preset) => preset.id === id)
}

/** 预设 id 列表（错误提示/工具枚举用） */
export const PRESET_IDS: string[] = PRESET_CATALOG.map((preset) => preset.id)

// ---------------------------------------------------------------------------
// 参数归一化
// ---------------------------------------------------------------------------

function paramFallback(param: PresetParamDef): Json {
  if (param.default !== undefined) return param.default
  if (param.type === 'number') return 0
  if (param.type === 'select') return param.options?.[0]?.value ?? ''
  return ''
}

/**
 * 归一化预设参数：缺省补 default；number 保证有限数字；select 保证属于 options；
 * text/expr 转字符串（显式空串保留——「留空」是有效语义，例如 passExpr 留空=恒通过）。
 * 未声明的键丢弃（防止把表单脏数据写进产物）。
 */
export function normalizePresetParams(def: PresetDef, params: Record<string, Json> = {}): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const param of def.params) {
    const raw = Object.prototype.hasOwnProperty.call(params, param.key) ? params[param.key] : undefined
    const value = raw === undefined ? paramFallback(param) : raw
    if (param.type === 'number') {
      const numeric =
        typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
      out[param.key] = Number.isFinite(numeric) ? numeric : paramFallback(param)
      continue
    }
    if (param.type === 'select') {
      const allowed = (param.options ?? []).map((option) => option.value)
      out[param.key] = typeof value === 'string' && allowed.includes(value) ? value : paramFallback(param)
      continue
    }
    out[param.key] = value === null || value === undefined ? paramFallback(param) : String(value)
  }
  return out
}

/** 预设参数默认值表（画廊初始化表单用） */
export function presetDefaults(def: PresetDef): Record<string, Json> {
  return normalizePresetParams(def, {})
}

// ---------------------------------------------------------------------------
// 展开
// ---------------------------------------------------------------------------

function assertArray(value: unknown, what: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`预设展开结果缺少 ${what}`)
}

/**
 * 结构自检：id 唯一且形态合法、边端点存在、无自环/悬垂、端口协议、入口无入边、
 * 结束点无出边、`entryId` 存在于结果内。build 产物不合法 → 中文错误（不会写坏文档）。
 */
function assertPresetResult(def: PresetDef, result: PresetBuildResult): void {
  assertArray(result.nodes, '节点（nodes）')
  assertArray(result.edges, '连线（edges）')
  if (result.nodes.length === 0) throw new Error(`预设「${def.name}」展开结果为空（没有节点）`)
  const nodeIds = new Set<string>()
  const kindById = new Map<string, string>()
  for (const node of result.nodes) {
    const id = (node as { id?: unknown }).id
    if (typeof id !== 'string' || !isV4LocalId(id)) {
      throw new Error(`预设「${def.name}」生成的节点 id「${String(id)}」形态非法`)
    }
    if (nodeIds.has(id)) throw new Error(`预设「${def.name}」生成的节点 id「${id}」重复`)
    nodeIds.add(id)
    kindById.set(id, String((node as { kind?: unknown }).kind ?? ''))
  }
  const edgeIds = new Set<string>()
  const usedPorts = new Set<string>()
  for (const edge of result.edges) {
    if (typeof edge.id !== 'string' || !isV4LocalId(edge.id)) {
      throw new Error(`预设「${def.name}」生成的连线 id「${String(edge.id)}」形态非法`)
    }
    if (edgeIds.has(edge.id)) throw new Error(`预设「${def.name}」生成的连线 id「${edge.id}」重复`)
    edgeIds.add(edge.id)
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`预设「${def.name}」生成的连线「${edge.id}」悬空（${edge.from} → ${edge.to}）`)
    }
    if (edge.from === edge.to) throw new Error(`预设「${def.name}」生成的连线「${edge.id}」不能自环`)
    const fromKind = kindById.get(edge.from) ?? ''
    const toKind = kindById.get(edge.to) ?? ''
    if (fromKind === 'comment' || toKind === 'comment') {
      throw new Error(`预设「${def.name}」生成的连线不能连接 comment 节点`)
    }
    const dual = fromKind === 'branch' || fromKind === 'loop' || fromKind === 'foreach'
    if (dual && edge.port === undefined) {
      throw new Error(`预设「${def.name}」的 ${fromKind} 节点「${edge.from}」出边必须指定端口`)
    }
    if (!dual && edge.port !== undefined) {
      throw new Error(`预设「${def.name}」的单出口节点「${edge.from}」出边不能指定端口`)
    }
    if (dual) {
      const key = `${edge.from}:${edge.port}`
      if (usedPorts.has(key)) throw new Error(`预设「${def.name}」的节点「${edge.from}」同一端口有多条出边`)
      usedPorts.add(key)
    }
    if (fromKind === 'return' || fromKind === 'restart') {
      throw new Error(`预设「${def.name}」的结束节点「${edge.from}」不能有出边`)
    }
    if (toKind === 'start' || toKind === 'on') {
      throw new Error(`预设「${def.name}」的入口节点「${edge.to}」不能有入边`)
    }
  }
  if (result.entryId !== undefined && !nodeIds.has(result.entryId)) {
    throw new Error(`预设「${def.name}」的 entryId「${result.entryId}」不在展开结果内`)
  }
}

/**
 * 展开预设（纯函数）：参数先归一化（缺省/类型/选项），build 产物经结构自检后返回。
 * - flow 预设可独立展开；behavior 预设必须给 `ctx.typeId`（否则无从校验 surface 组件）；
 * - 未知 id / 参数非法 / 组件不存在 → 中文 Error（画廊会展示，不会写坏文档）。
 */
export function buildPreset(
  id: string,
  ctx: PresetCtx,
  params: Record<string, Json> = {},
): PresetBuildResult {
  const def = getPreset(id)
  if (!def) throw new Error(`未知预设「${id}」；可用预设：${PRESET_IDS.join(' / ')}`)
  if (def.layer === 'behavior' && (ctx.typeId === undefined || ctx.typeId === '')) {
    throw new Error(`行为预设「${def.name}」需要题型 id（typeId）——请在「题型 → 行为」里插入`)
  }
  const normalized = normalizePresetParams(def, params)
  const result = def.build(ctx, normalized)
  assertPresetResult(def, result)
  return result
}

// ---------------------------------------------------------------------------
// 文档级装配（模板 / AI / 编辑器接入方可直接用）
// ---------------------------------------------------------------------------

export interface InsertPresetOptions {
  /** behavior 层必填 */
  typeId?: string
  params?: Record<string, Json>
  /** 是否自动补齐 flow 预设依赖的 run 变量声明（默认 true；已声明的同 key 跳过） */
  declare?: boolean
}

export interface InsertPresetOutcome {
  doc: LevelDocV4
  result: PresetBuildResult
  /** 本次自动补进 flow.vars 的声明（空数组 = 无需补齐/已声明/behavior 层） */
  declarations: StateFieldDef[]
}

/**
 * 展开预设并装配进文档（纯函数、结构共享）：
 * - flow 层：并入 `content.flow`；默认补齐 v.score / v.row 等 run 变量声明；
 * - behavior 层：并入 `content.types[typeId].behavior`；
 * - 返回新文档 + 展开结果 + 补进的声明，调用方可一次 update 写入撤销栈。
 */
export function insertPresetIntoDoc(
  doc: LevelDocV4,
  presetId: string,
  options: InsertPresetOptions = {},
): InsertPresetOutcome {
  const def = getPreset(presetId)
  if (!def) throw new Error(`未知预设「${presetId}」；可用预设：${PRESET_IDS.join(' / ')}`)
  const params = options.params ?? {}
  const result = buildPreset(presetId, { doc, typeId: options.typeId }, params)
  let next = applyPresetResultToDoc(doc, def.layer, options.typeId, result)
  const declarations: StateFieldDef[] = []
  if (def.layer === 'flow' && options.declare !== false) {
    const required = presetDeclarations(presetId, normalizePresetParams(def, params))
    const existing = new Set((next.content.flow.vars ?? []).map((field) => field.key))
    const missing = required.filter((field) => !existing.has(field.key))
    if (missing.length > 0) {
      declarations.push(...missing)
      next = {
        ...next,
        content: {
          ...next.content,
          flow: { ...next.content.flow, vars: [...(next.content.flow.vars ?? []), ...missing] },
        },
      }
    }
  }
  return { doc: next, result, declarations }
}
