/**
 * 文档校验与装载管线：Ajv（schema 注册一次共享）→ schemaVersion 检查 → 逻辑迁移与 lint。
 * 未知组件类型不在此拒绝——运行时 store 会降级为占位组件（docs/02 §7）。
 * 关卡逻辑：v1 ECA 程序在此透明迁移为 GraphProgram v2 后入库（装载/保存出的内容恒为 v2）。
 */
import Ajv2020 from 'ajv/dist/2020'
import type { LevelDoc } from '../engine/level'
import { lintGraphProgram } from '../engine/graphProgram'
import { migrateDocToV3 } from '../engine/migrateDoc'
import type { ResourceKind } from './db'

export const SCHEMA_BASE = 'https://music-practise.local/schemas/v1/'
const BASE = SCHEMA_BASE
export const KNOWN_KINDS: ResourceKind[] = ['series', 'topic', 'level', 'instrument']

let cachedAjv: Ajv2020 | null = null

export function buildAjv(): Ajv2020 {
  if (cachedAjv) return cachedAjv
  const ajv = new Ajv2020({ strict: false, allErrors: true })
  for (const schema of SCHEMA_RAW) {
    ajv.addSchema(schema)
  }
  cachedAjv = ajv
  return ajv
}

// 显式静态导入（Vite JSON 模块）；新增 schema 时在此与 KNOWN_KINDS 同步
import commonRaw from '../../schemas/v1/common.json'
import logicRaw from '../../schemas/v1/logic.json'
import graphLogicRaw from '../../schemas/v1/graph-logic.json'
import levelRaw from '../../schemas/v1/level.json'
import seriesRaw from '../../schemas/v1/series.json'
import topicRaw from '../../schemas/v1/topic.json'
import instrumentRaw from '../../schemas/v1/instrument.json'

const SCHEMA_RAW = [commonRaw, logicRaw, graphLogicRaw, levelRaw, seriesRaw, topicRaw, instrumentRaw]

export function validateEnvelope(
  kind: string,
  doc: unknown,
): { ok: boolean; errors: string[] } {
  if (!KNOWN_KINDS.includes(kind as ResourceKind)) {
    return { ok: false, errors: [`未知的文档 kind: ${String(kind)}`] }
  }
  const ajv = buildAjv()
  const validate = ajv.getSchema(`${BASE}${kind}.json`)
  if (!validate) return { ok: false, errors: [`schema 未注册: ${kind}`] }
  const ok = validate(doc) as boolean
  return {
    ok,
    errors: ok ? [] : (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? '校验失败'}`),
  }
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
