import { jsonResponse, HttpError, readJsonBody } from '../http'
import { requireUser } from '../session'
import type { RouteContext } from '../router'

/**
 * 通关记录 API（docs/31 §5.3，批次 B3）：GET 全量拉取、PUT 批量 upsert。
 * upsert 各字段 MAX(旧, 新)——幂等、可交换，重复同步/多端并发均收敛一致；
 * attempts 取 max 而非相加，避免多端翻倍。
 */
const MAX_BATCH = 500
const LEVEL_ID_RE = /^res_[0-9A-HJKMNP-TV-Z]{26}$/

interface ProgressInput {
  levelId: string
  bestScore: number
  passed: number
  attempts: number
  updatedAt: number
}

/** 逐字段校验 + 钳制；非法类型拒绝（客户端 bug 才会发坏数据），越界数值钳制 */
function clampRecord(raw: unknown, index: number): ProgressInput {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError(400, 'bad_request', `records[${index}] 不是对象`)
  }
  const r = raw as Record<string, unknown>
  if (typeof r.levelId !== 'string' || !LEVEL_ID_RE.test(r.levelId)) {
    throw new HttpError(400, 'bad_request', `records[${index}].levelId 不是合法的关卡资源 id`)
  }
  const bestScore = Number(r.bestScore)
  if (!Number.isFinite(bestScore)) throw new HttpError(400, 'bad_request', `records[${index}].bestScore 必须是数字`)
  const passed = Number(r.passed)
  if (passed !== 0 && passed !== 1) throw new HttpError(400, 'bad_request', `records[${index}].passed 必须是 0 或 1`)
  const attempts = Number(r.attempts)
  if (!Number.isInteger(attempts) || attempts < 0) throw new HttpError(400, 'bad_request', `records[${index}].attempts 必须是非负整数`)
  const updatedAt = Number(r.updatedAt)
  if (!Number.isInteger(updatedAt) || updatedAt < 0) throw new HttpError(400, 'bad_request', `records[${index}].updatedAt 必须是非负整数`)
  return {
    levelId: r.levelId,
    bestScore: Math.min(Math.max(bestScore, 0), 1e9),
    passed,
    attempts: Math.min(attempts, 1e6),
    updatedAt: Math.min(updatedAt, 4_102_444_800_000),
  }
}

/** GET /api/progress：全量拉取 */
export async function listProgress({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(env.DB, req, Date.now())
  const result = await env.DB
    .prepare('SELECT level_id, best_score, passed, attempts, updated_at FROM progress WHERE user_id = ?')
    .bind(session.user.id)
    .all<{ level_id: string; best_score: number; passed: number; attempts: number; updated_at: number }>()
  const records = (result.results ?? []).map((r) => ({
    levelId: r.level_id,
    bestScore: Number(r.best_score),
    passed: Number(r.passed),
    attempts: Number(r.attempts),
    updatedAt: Number(r.updated_at),
  }))
  return jsonResponse({ records })
}

/** PUT /api/progress：批量 upsert（MAX 单调合并） */
export async function putProgress({ req, env }: RouteContext): Promise<Response> {
  const body = await readJsonBody(req, 256 * 1024)
  const session = await requireUser(env.DB, req, Date.now())
  const rawRecords = (body as { records?: unknown }).records
  if (!Array.isArray(rawRecords)) throw new HttpError(400, 'bad_request', 'records 必须是数组')
  if (rawRecords.length > MAX_BATCH) throw new HttpError(400, 'bad_request', `单次最多 ${MAX_BATCH} 条记录`)
  const records = rawRecords.map(clampRecord)
  const statements = records.map((r) =>
    env.DB
      .prepare(
        'INSERT INTO progress (user_id, level_id, best_score, passed, attempts, updated_at) VALUES (?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(user_id, level_id) DO UPDATE SET ' +
          'best_score = MAX(excluded.best_score, progress.best_score), ' +
          'passed = MAX(excluded.passed, progress.passed), ' +
          'attempts = MAX(excluded.attempts, progress.attempts), ' +
          'updated_at = MAX(excluded.updated_at, progress.updated_at)',
      )
      .bind(session.user.id, r.levelId, r.bestScore, r.passed, r.attempts, r.updatedAt),
  )
  if (statements.length > 0) await env.DB.batch(statements)
  return jsonResponse({ ok: true, applied: records.length })
}
