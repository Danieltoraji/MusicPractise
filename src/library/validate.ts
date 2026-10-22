/**
 * 文档校验与装载管线：JSON Schema 校验（@cfworker/json-schema，注册一次共享）
 * → schemaVersion 检查 → 逻辑迁移与 lint。
 * 未知组件类型不在此拒绝——运行时 store 会降级为占位组件（docs/02 §7）。
 * 关卡逻辑：v1 ECA 程序在此透明迁移为 GraphProgram v2 后入库（装载/保存出的内容恒为 v2）。
 *
 * 校验器选型（docs/34）：不用 Ajv——其编译期 new Function 动态生成校验器，
 * 部署站点 CSP 为 script-src 'self'（worker/http.ts + public/_headers），
 * 触发 EvalError 并令所有 AI 工具（经 loadLevelDoc）宿主级失败。
 * cfworker 版是闭包式校验器、无动态求值，与服务端 worker/schema.ts 同款。
 * 跨文件 $ref（common/logic 等）以完整 $id 注册解析。
 */
import { Validator, type Schema } from '@cfworker/json-schema'
import type { LevelDoc } from '../engine/level'
import { lintGraphProgram } from '../engine/graphProgram'
import { migrateDocToV3 } from '../engine/migrateDoc'
import type { ResourceKind } from './db'

export const SCHEMA_BASE = 'https://music-practise.local/schemas/v1/'

// 显式静态导入（Vite JSON 模块）；新增 schema 时在此与 KNOWN_KINDS 同步
import commonRaw from '../../schemas/v1/common.json'
import logicRaw from '../../schemas/v1/logic.json'
import graphLogicRaw from '../../schemas/v1/graph-logic.json'
import levelRaw from '../../schemas/v1/level.json'
import seriesRaw from '../../schemas/v1/series.json'
import topicRaw from '../../schemas/v1/topic.json'
import instrumentRaw from '../../schemas/v1/instrument.json'

/** 全部原始 schema（按 $id 注册共享）；schemas.test.ts 借此自建测试用 Ajv 实例 */
export const SCHEMA_RAW = [commonRaw, logicRaw, graphLogicRaw, levelRaw, seriesRaw, topicRaw, instrumentRaw]

export const KNOWN_KINDS: ResourceKind[] = ['series', 'topic', 'level', 'instrument']

const SCHEMA_BY_KIND: Record<ResourceKind, Schema> = {
  level: levelRaw as Schema,
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
  const result = validatorFor(kind as ResourceKind).validate(doc)
  if (result.valid) return { ok: true, errors: [] }
  return { ok: false, errors: formatSchemaErrors(result.errors) }
}

// ---------------------------------------------------------------------------
// 校验错误可读化（docs/40 A5）：oneOf 双分支归纳 → 位置中文化 → 关键词映射 → 截断。
// AGENTS 约定「校验错误须带行:列 + 消息」——JSON 文档没有行列，等价物是「位置 + 消息」。
// ---------------------------------------------------------------------------

/** 错误条数上限：oneOf 双分支失败可上百行，作者只需要最先出现的若干条 */
export const MAX_SHOWN_ERRORS = 20

/** 截断为上限并附总数提示（导出供测试；cfworker 对数组 items 首败即短路，自然错误流难超限） */
export function capErrorLines(lines: string[]): string[] {
  if (lines.length <= MAX_SHOWN_ERRORS) return lines
  return [...lines.slice(0, MAX_SHOWN_ERRORS), `……另有 ${lines.length - MAX_SHOWN_ERRORS} 条同类错误未显示`]
}

/** 数据位置转中文：表格行号/组件/视图序号转「第 N 行/项」，其余保留原路径。
 *  cfworker 的 instanceLocation 带 URI fragment 前缀（#/content/...），先剥离。 */
function formatInstanceLocation(loc: string): string {
  const p = loc.startsWith('#') ? loc.slice(1) : loc
  let m = /^\/content\/table\/rows\/(\d+)(.*)$/.exec(p)
  if (m) return `数据表第 ${Number(m[1]) + 1} 行${formatRest(m[2])}`
  m = /^\/content\/components\/(\d+)(.*)$/.exec(p)
  if (m) return `组件第 ${Number(m[1]) + 1} 项${formatRest(m[2])}`
  m = /^\/content\/views\/(\d+)(.*)$/.exec(p)
  if (m) return `视图第 ${Number(m[1]) + 1} 项${formatRest(m[2])}`
  if (p.startsWith('/meta')) return `元信息${formatRest(p.slice(5))}`
  return p === '/' || p === '' ? '文档根' : formatRest(p)
}

/** 段内剩余路径 `/notes/0/dur` → ` · notes[0] · dur`（段太长直接保留原样） */
function formatRest(rest: string): string {
  if (!rest) return ''
  const segs = rest.split('/').filter(Boolean)
  if (segs.length > 4) return `（${rest}）`
  return segs.map((s) => (/^\d+$/.test(s) ? `[${s}]` : ` · ${s}`)).join('')
}

/** schema 关键词 → 中文短标签（细节保留校验器原文，其本身可读） */
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

/** 中间结构包装行（无用户价值）：oneOf/$ref/properties/items 只描述「子模式有错」的过程 */
const WRAPPER_KEYWORDS = new Set(['oneOf', '$ref', 'properties', 'items'])

function formatSchemaErrors(errors: { keyword: string; instanceLocation: string; keywordLocation: string; error: string }[]): string[] {
  // oneOf 归纳（docs/40 A5）：level 根 schema = oneOf[V1Level, V3Level]，双分支全量失败会翻倍刷屏。
  // cfworker 的 keywordLocation 就地展开 $ref：v3 = #/oneOf/1/…。v3 分支有叶子错误则只看 v3。
  const isV3 = (e: { keywordLocation: string }): boolean => e.keywordLocation.includes('#/oneOf/1/')
  const leaf = errors.filter((e) => !WRAPPER_KEYWORDS.has(e.keyword))
  const v3 = leaf.filter(isV3)
  const picked = v3.length > 0 ? v3 : leaf
  const v1Note =
    v3.length === 0 && leaf.some((e) => e.keywordLocation.includes('#/oneOf/0/'))
      ? ['（文档按 v1 旧格式规则检查未通过——装载管线会自动升级为 v3，请优先核对以下字段）']
      : []
  const lines = picked.map((e) => {
    const label = KEYWORD_LABEL[e.keyword]
    const pos = formatInstanceLocation(e.instanceLocation)
    return label ? `${pos}：${label}——${e.error}` : `${pos}：${e.error}`
  })
  // 去重（同位置同错误只报一次）+ 截断
  const seen = new Set<string>()
  const uniq = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)))
  return [...v1Note, ...capErrorLines(uniq)]
}

/**
 * D5 唯一性预检（schema 无法表达的约束）：组件 id / 视图 id / 表列 key 重复。
 * 重复后果：ComponentStore 后者覆盖前者、React key 冲突、按 id 删除一次删掉全部同 id。
 * 保存/导入/AI 写入走 loadLevelDoc 时作为错误拦截；编辑器装载走宽松告警（见 EditorPage）。
 */
export function findDuplicateIdErrors(doc: LevelDoc): string[] {
  const errors: string[] = []
  const dup = (ids: string[], what: string, nameOf?: (id: string) => string): void => {
    const counts = new Map<string, number>()
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const [id, n] of counts) {
      if (n > 1) errors.push(`${what} id「${nameOf ? nameOf(id) : id}」重复出现 ${n} 次——同 id 实例会互相覆盖，请改为唯一 id`)
    }
  }
  dup(doc.content.components.map((c) => c.id), '组件')
  dup(doc.content.views.map((v) => v.id), '视图')
  dup(doc.content.table.columns.map((c) => c.key), '数据表列', (k) => `key:${k}`)
  return errors
}

export type LoadResult =
  | { ok: true; doc: LevelDoc; lintWarnings: string[] }
  | { ok: false; errors: string[] }

/** 关卡装载管线：信封 schema（v1|v3）→ 文档迁移器（统一出 v3）→ 逻辑 lint */
export function loadLevelDoc(raw: unknown): LoadResult {
  const errors: string[] = []
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['文档不是 JSON 对象'] }
  }
  const kind = (raw as { kind?: unknown }).kind
  if (kind !== 'level') {
    return { ok: false, errors: [`kind 不是 level（实际: ${String(kind)}）。请用资源库导入其他类型文档`] }
  }
  const env = validateEnvelope('level', raw)
  if (!env.ok) errors.push(...env.errors)

  const source = raw as { schemaVersion?: unknown }
  if (source.schemaVersion !== 1 && source.schemaVersion !== 3) {
    errors.push(`schemaVersion ${String(source.schemaVersion)} 不受支持（支持 1 → 自动升级 3；3 为当前格式）`)
  }

  let lintWarnings: string[] = []
  if (errors.length === 0) {
    // 迁移器统一出 v3：v1 questions → 数据表、logicPatch → 行门控子图、组件归属视图、
    // 逻辑 v1 ECA → v2 图 IR。不变异调用方传入的对象（浅拷贝后写入）。
    let doc: LevelDoc
    try {
      doc = migrateDocToV3(source)
    } catch (err) {
      // schema 合法但迁移器拒绝：作为装载错误而非崩溃
      return { ok: false, errors: [`文档迁移失败: ${err instanceof Error ? err.message : String(err)}`] }
    }
    // D5：重复 id（组件/视图/列 key）在保存/导入/AI 写入路径直接拦截（装载宽松告警另行处理）
    errors.push(...findDuplicateIdErrors(doc))
    if (errors.length > 0) return { ok: false, errors }
    lintWarnings = lintGraphProgram(doc.content.logic, {
      componentIds: doc.content.components.map((c) => c.id),
      viewIds: doc.content.views.map((v) => v.id),
    })
    // v3 结构告警（schema 无法表达的约束，评审 P2-12/13）
    const viewIdSet = new Set(doc.content.views.map((v) => v.id))
    for (const c of doc.content.components) {
      if (c.view !== undefined && !viewIdSet.has(c.view)) {
        lintWarnings.push(`组件 ${c.id} 指向不存在的视图 "${c.view}"——该组件不会渲染（视图缺省取首视图）`)
      }
    }
    return { ok: true, doc, lintWarnings }
  }

  return { ok: false, errors }
}
