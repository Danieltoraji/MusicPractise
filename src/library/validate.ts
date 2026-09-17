/**
 * 文档校验与装载管线：Ajv（schema 注册一次共享）→ schemaVersion 检查 → 逻辑 lint。
 * 未知组件类型不在此拒绝——运行时 store 会降级为占位组件（docs/02 §7）。
 */
import Ajv2020 from 'ajv/dist/2020'
import type { LevelDoc } from '../engine/level'
import { LogicEngine } from '../engine/logic'
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
import levelRaw from '../../schemas/v1/level.json'
import seriesRaw from '../../schemas/v1/series.json'
import topicRaw from '../../schemas/v1/topic.json'
import instrumentRaw from '../../schemas/v1/instrument.json'

const SCHEMA_RAW = [commonRaw, logicRaw, levelRaw, seriesRaw, topicRaw, instrumentRaw]

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

/** 关卡装载管线：信封 schema → schemaVersion → 逻辑 lint */
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

  const doc = raw as LevelDoc
  if (doc.schemaVersion !== 1) {
    errors.push(`schemaVersion ${String(doc.schemaVersion)} 不受支持（当前支持 1，旧文档迁移器尚未提供）`)
  }

  let lintWarnings: string[] = []
  if (errors.length === 0) {
    const patchVarKeys = new Set<string>()
    for (const q of doc.content.questions) {
      for (const key of Object.keys(q.logicPatch?.variables ?? {})) patchVarKeys.add(key)
    }
    lintWarnings = LogicEngine.lint(doc.content.logic, {
      componentIds: doc.content.components.map((c) => c.id),
      extraVariableKeys: patchVarKeys,
    })
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, doc, lintWarnings }
}
