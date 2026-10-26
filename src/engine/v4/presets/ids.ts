/**
 * 预设展开的稳定 id 分配（docs/53 §14）。
 *
 * 约定：
 * - 节点 id = `ps_<预设 id 净化>_<实例号>_<角色>`，**程序化、稳定、可读**，不手抄随机 id；
 *   实例号 = 当前层程序里同前缀 id 的最大实例号 + 1 —— 同一预设重复插入会产生新实例，
 *   不会与已有节点/边冲突（与「重新插入即可」的印章语义一致）。
 * - 边 id = `ps_<…>_<实例号>_e<序号>`，在本次展开内唯一。
 * - 全部 id 满足 engine/v4/model 的 LocalId 形态（≤64 字符、字母/下划线开头、不含 `.`）。
 */
import type { GraphEdge, LevelDocV4 } from '../model'
import { getType } from '../model'
import type { PresetLayer } from './types'

/** 前缀上限：留出实例号/角色名的长度，整体仍满足 LocalId ≤64 */
const BASE_PART_MAX = 30
/** 角色名上限（foreach/addscore 之类短名） */
const ROLE_MAX = 12

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sanitizePart(part: string): string {
  const cleaned = part.replace(/[^A-Za-z0-9_]/g, '_')
  const withLetterStart = /^[A-Za-z_]/.test(cleaned) ? cleaned : `p_${cleaned}`
  return withLetterStart.slice(0, BASE_PART_MAX)
}

function sanitizeRole(role: string): string {
  const cleaned = role.replace(/[^A-Za-z0-9_]/g, '_')
  const withLetterStart = /^[A-Za-z_]/.test(cleaned) ? cleaned : `r_${cleaned}`
  return withLetterStart.slice(0, ROLE_MAX)
}

interface ProgramLike {
  nodes: { id: string }[]
  edges: GraphEdge[]
}

function programFor(doc: LevelDocV4, layer: PresetLayer, typeId?: string): ProgramLike {
  if (layer === 'flow') return doc.content.flow
  if (typeId === undefined || typeId === '') {
    throw new Error('行为预设需要题型 id（typeId）：请在题型 → 行为页内插入')
  }
  const type = getType(doc, typeId)
  if (!type) throw new Error(`题型「${typeId}」不存在，无法展开行为预设`)
  return type.behavior
}

/** 预设展开的 id 分配器（每次 build 新建一个；实例号按当前程序自动递增） */
export interface PresetIds {
  /** 预设 id 净化前缀（如 `ps_sequence_grade_settle`） */
  readonly base: string
  /** 本次展开的实例号（同前缀从 1 递增） */
  readonly instance: number
  /** 生成一个节点 id（角色名用于可读性） */
  node(role: string): string
  /** 生成一条边（端口按 IR 协议：双出口节点必须给 true/false，单出口不得给） */
  edge(from: string, to: string, port?: 'true' | 'false'): GraphEdge
}

/** 为一次预设展开创建 id 分配器；`presetId` 即 PRESET_CATALOG 的 id */
export function createPresetIds(
  doc: LevelDocV4,
  layer: PresetLayer,
  typeId: string | undefined,
  presetId: string,
): PresetIds {
  const program = programFor(doc, layer, typeId)
  const base = `ps_${sanitizePart(presetId)}`
  const instancePattern = new RegExp(`^${escapeRegExp(base)}_(\\d+)_`)
  let maxInstance = 0
  for (const node of program.nodes) {
    const matched = instancePattern.exec(node.id)
    if (!matched) continue
    const value = Number(matched[1])
    if (Number.isFinite(value) && value > maxInstance) maxInstance = value
  }
  const instance = maxInstance + 1
  const usedEdges = new Set(program.edges.map((edge) => edge.id))
  let nodeCount = 0
  let edgeCount = 0
  return {
    base,
    instance,
    node(role: string): string {
      nodeCount += 1
      const rolePart = role === '' ? 'node' : sanitizeRole(role)
      return `${base}_${instance}_${rolePart}${nodeCount === 1 ? '' : `_${nodeCount}`}`
    },
    edge(from: string, to: string, port?: 'true' | 'false'): GraphEdge {
      let id = ''
      do {
        edgeCount += 1
        id = `${base}_${instance}_e${edgeCount}`
      } while (usedEdges.has(id))
      usedEdges.add(id)
      const edge: GraphEdge = { id, from, to }
      if (port !== undefined) edge.port = port
      return edge
    },
  }
}

// ---------------------------------------------------------------------------
// 参数取值助手（build 收到的是 normalizePresetParams 归一化后的参数）
// ---------------------------------------------------------------------------

/** 表达式参数：缺省/显式空串返回 fallback（空串 = 「不设置」语义，例如留空不写 passed） */
export function exprOf(params: Record<string, unknown>, key: string, fallback = ''): string {
  const value = params[key]
  if (typeof value !== 'string') return fallback
  return value.trim()
}

/** 文本参数：缺省返回 fallback；显式空串保留空串（例如可选组件 id = 不生成调用节点） */
export function textOf(params: Record<string, unknown>, key: string, fallback = ''): string {
  const value = params[key]
  if (typeof value !== 'string') return fallback
  return value.trim()
}

/** 数字参数（归一化阶段已保证有限数字；这里再防御一次） */
export function numOf(params: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** select 参数：归一化阶段已保证是 options 之一；这里再防御一次 */
export function selectOf(params: Record<string, unknown>, key: string, fallback: string): string {
  const value = params[key]
  return typeof value === 'string' && value !== '' ? value : fallback
}

/** 把任意文本转成表达式里的单引号字符串字面量（预设生成 call 参数用） */
export function exprString(text: string): string {
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `'${escaped}'`
}
