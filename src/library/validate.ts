/**
 * 文档校验与装载管线（v4，W9 翻转后唯一关卡管线）：
 * JSON Schema（@cfworker/json-schema，CSP 禁 eval；docs/34）→ normalizeLevelDocV4
 * → validateLevelDocV4（结构/引用/图完整性）→ lintLevelDocV4（表达式/权限/契约/可达性等）
 * → 返回 { doc, lintWarnings }。
 *
 * series/topic/instrument 仍复用 schemas/v1；level 只接受 `schemaVersion: 4`（旧 v1/v3 关卡不再可玩，
 * 迁移器已随 W9 删除）。校验器选型见 docs/34：不用 Ajv（编译期 new Function 会被生产 CSP 拦截）。
 */
import { Validator, type Schema } from '@cfworker/json-schema'
import type { LevelDocV4 } from '../engine/v4/model'
import { normalizeLevelDocV4 } from '../engine/v4/model'
import { validateLevelDocV4 } from '../engine/v4/validate'
import { lintLevelDocV4 } from '../engine/v4/lint'
import { allContracts } from '../runtime/store'
import type { ResourceKind } from './db'

export const SCHEMA_BASE = 'https://music-practise.local/schemas/v1/'
export const SCHEMA_BASE_V4 = 'https://music-practise.local/schemas/v4/'
export const SCHEMA_V4_LEVEL_ID = `${SCHEMA_BASE_V4}level.json`

// 显式静态导入（Vite JSON 模块）；新增 schema 时在此与 KNOWN_KINDS 同步
import commonRaw from '../../schemas/v1/common.json'
import levelV4Raw from '../../schemas/v4/level.json'
import seriesRaw from '../../schemas/v1/series.json'
import topicRaw from '../../schemas/v1/topic.json'
import instrumentRaw from '../../schemas/v1/instrument.json'

/** 全部原始 schema（按 $id 注册共享）；schemas.test.ts 借此自建测试用 Ajv 实例 */
export const SCHEMA_RAW = [commonRaw, levelV4Raw, seriesRaw, topicRaw, instrumentRaw]

export const KNOWN_KINDS: ResourceKind[] = ['series', 'topic', 'level', 'instrument']

const SCHEMA_BY_KIND: Record<ResourceKind, Schema> = {
  level: levelV4Raw as Schema,
  series: seriesRaw as Schema,
  topic: topicRaw as Schema,
  instrument: instrumentRaw as Schema,
}

/** 各 kind 一个校验器（惰性建一次）；其余 schema 以 $id 注册供跨文件 $ref 解析 */
const validators = new Map<ResourceKind, Validator>()

function validatorFor(kind: ResourceKind): Validator {
  const cached = validators.get(kind)
  if (cached) return cached
  const root = SCHEMA_BY_KIND[kind]
  const rootId = (root as { $id?: string }).$id
  const validator = new Validator(root)
  for (const schema of SCHEMA_RAW) {
    const id = (schema as { $id?: string }).$id
    // 根 schema 已随构造器注册，重复 addSchema 同一 $id 会被 cfworker 拒绝
    if (id && id !== rootId) validator.addSchema(schema as Schema, id)
  }
  validators.set(kind, validator)
  return validator
}

export function validateEnvelope(
  kind: string,
  doc: unknown,
): { ok: boolean; errors: string[] } {
  if (!KNOWN_KINDS.includes(kind as ResourceKind)) {
    return { ok: false, errors: [`未知的文档 kind: ${String(kind)}`] }
  }
  try {
    const result = validatorFor(kind as ResourceKind).validate(doc)
    if (result.valid) return { ok: true, errors: [] }
    return { ok: false, errors: formatSchemaErrors(result.errors) }
  } catch (err) {
    // cfworker 遇到 undefined 属性值会直接抛异常（历史上脚本合并曾写出显式 x: undefined）；
    // 校验器异常一律转成可读装载错误，不向上抛。
    const detail = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      errors: [
        `文档包含校验器无法处理的值（常见原因是字段值为 undefined，例如旧图合并残留的坐标）——${detail}`,
      ],
    }
  }
}

// ---------------------------------------------------------------------------
// 校验错误可读化
// ---------------------------------------------------------------------------

/** 错误条数上限（文档没有行列，等价物是「位置 + 消息」） */
export const MAX_SHOWN_ERRORS = 20

export function capErrorLines(lines: string[]): string[] {
  if (lines.length <= MAX_SHOWN_ERRORS) return lines
  return [...lines.slice(0, MAX_SHOWN_ERRORS), `……另有 ${lines.length - MAX_SHOWN_ERRORS} 条同类错误未显示`]
}

/** 数据位置转中文：v4 结构路径 → 题型/行/列/组件/题单/流程等可读定位 */
function formatInstanceLocation(loc: string): string {
  const p = loc.startsWith('#') ? loc.slice(1) : loc
  let m = /^\/content\/types\/(\d+)\/surface\/components\/(\d+)(.*)$/.exec(p)
  if (m) return `题型第 ${Number(m[1]) + 1} 个的表现组件第 ${Number(m[2]) + 1} 项${formatRest(m[3])}`
  m = /^\/content\/types\/(\d+)\/behavior\/(nodes|edges)\/(\d+)(.*)$/.exec(p)
  if (m) {
    const what = m[2] === 'nodes' ? '行为节点' : '行为连线'
    return `题型第 ${Number(m[1]) + 1} 个的${what}第 ${Number(m[3]) + 1} 项${formatRest(m[4])}`
  }
  m = /^\/content\/types\/(\d+)\/(state|typeState|args)\/(\d+)(.*)$/.exec(p)
  if (m) {
    const what = m[2] === 'state' ? '实例态字段' : m[2] === 'typeState' ? '题型态字段' : '参数'
    return `题型第 ${Number(m[1]) + 1} 个的${what}第 ${Number(m[3]) + 1} 项${formatRest(m[4])}`
  }
  m = /^\/content\/types\/(\d+)(.*)$/.exec(p)
  if (m) return `题型第 ${Number(m[1]) + 1} 个${formatRest(m[2])}`
  m = /^\/content\/tables\/([^/]+)\/rows\/(\d+)(.*)$/.exec(p)
  if (m) return `题型「${m[1]}」第 ${Number(m[2]) + 1} 行${formatRest(m[3])}`
  m = /^\/content\/tables\/([^/]+)\/columns\/(\d+)(.*)$/.exec(p)
  if (m) return `题型「${m[1]}」第 ${Number(m[2]) + 1} 列${formatRest(m[3])}`
  m = /^\/content\/tables\/([^/]+)(.*)$/.exec(p)
  if (m) return `题型「${m[1]}」的实例表${formatRest(m[2])}`
  m = /^\/content\/shell\/(components|views)\/(\d+)(.*)$/.exec(p)
  if (m) {
    const what = m[1] === 'components' ? 'shell 组件' : '视图'
    return `${what}第 ${Number(m[2]) + 1} 项${formatRest(m[3])}`
  }
  m = /^\/content\/manifest\/entries\/(\d+)(.*)$/.exec(p)
  if (m) return `题单第 ${Number(m[1]) + 1} 项${formatRest(m[2])}`
  m = /^\/content\/flow\/(nodes|edges)\/(\d+)(.*)$/.exec(p)
  if (m) {
    const what = m[1] === 'nodes' ? '流程节点' : '流程连线'
    return `${what}第 ${Number(m[2]) + 1} 项${formatRest(m[3])}`
  }
  m = /^\/content\/run(.*)$/.exec(p)
  if (m) return `运行配置${formatRest(m[1])}`
  if (p.startsWith('/meta')) return `元信息${formatRest(p.slice(5))}`
  if (p === '/' || p === '') return '文档根'
  const rest = formatRest(p)
  return rest.startsWith(' · ') ? rest.slice(3) : rest
}

/** 段内剩余路径 `/notes/0/dur` → ` · notes[0] · dur`（段太长直接保留原样） */
function formatRest(rest: string): string {
  if (!rest) return ''
  const segs = rest.split('/').filter(Boolean)
  if (segs.length > 4) return `（${rest}）`
  return segs.map((s) => (/^\d+$/.test(s) ? `[${s}]` : ` · ${s}`)).join('')
}

const KEYWORD_LABEL: Record<string, string> = {
  required: '缺少必填字段',
  const: '值不匹配',
  enum: '值不在允许范围',
  type: '类型不符',
  pattern: '格式不符',
  format: '格式不符',
  maxLength: '长度超限',
  minLength: '长度不足',
  maximum: '数值超上限',
  minimum: '数值低于下限',
  maxItems: '数量超上限',
  minItems: '数量不足',
  additionalProperties: '含未定义字段',
  propertyNames: '名称格式不符',
  uniqueItems: '存在重复项',
}

/** 中间结构包装行（无用户价值）：只描述「子模式有错」的过程 */
const WRAPPER_KEYWORDS = new Set(['oneOf', '$ref', 'properties', 'items', 'anyOf'])

function formatSchemaErrors(
  errors: { keyword: string; instanceLocation: string; error: string }[],
): string[] {
  const leaf = errors.filter((e) => !WRAPPER_KEYWORDS.has(e.keyword))
  const lines = leaf.map((e) => {
    const label = KEYWORD_LABEL[e.keyword]
    const pos = formatInstanceLocation(e.instanceLocation)
    return label ? `${pos}：${label}——${e.error}` : `${pos}：${e.error}`
  })
  const seen = new Set<string>()
  const uniq = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)))
  return capErrorLines(uniq)
}

// ---------------------------------------------------------------------------
// 关卡装载（v4）
// ---------------------------------------------------------------------------

export type LoadResult =
  | { ok: true; doc: LevelDocV4; lintWarnings: string[] }
  | { ok: false; errors: string[] }

/** 兼容旧调用名（过渡期已收敛为同一 v4 管线；W9 后统一用 loadLevelDoc） */
export type LoadResultV4 = LoadResult

/** 组件类型 → 契约（v4 lint 用；模块级构建一次） */
const CONTRACT_BY_TYPE = new Map(allContracts().map((contract) => [contract.type, contract]))

/**
 * 关卡装载管线（唯一入口）：JSON Schema → normalize → 结构/引用校验 → 语义 lint。
 * - validate 的 errors 拒绝装载；
 * - validate warnings + lint issues 统一作为 lintWarnings（编辑器可打开修复，与 v3 口径一致）。
 */
export function loadLevelDoc(raw: unknown): LoadResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['文档不是 JSON 对象'] }
  }
  const source = raw as { kind?: unknown; schemaVersion?: unknown }
  if (source.kind !== 'level') {
    return {
      ok: false,
      errors: [`kind 不是 level（实际: ${String(source.kind)}）。请用资源库导入其他类型文档`],
    }
  }
  if (source.schemaVersion !== 4) {
    return {
      ok: false,
      errors: [
        `schemaVersion ${String(source.schemaVersion)} 不受支持：当前关卡格式为 4（旧 v1/v3 关卡不再可玩，请用 v4 编辑器重做）`,
      ],
    }
  }
  const env = validateEnvelope('level', raw)
  if (!env.ok) return { ok: false, errors: env.errors }
  const doc = normalizeLevelDocV4(raw)
  const result = validateLevelDocV4(doc)
  if (!result.ok) return { ok: false, errors: result.errors.map((issue) => issue.message) }
  const lintIssues = lintLevelDocV4(doc, { contractOf: (type) => CONTRACT_BY_TYPE.get(type) })
  const lintWarnings = [...result.warnings, ...lintIssues].map((issue) => issue.message)
  return { ok: true, doc, lintWarnings }
}

/** 过渡别名（既有调用点/测试逐步收敛到 loadLevelDoc） */
export const loadLevelDocV4 = loadLevelDoc
