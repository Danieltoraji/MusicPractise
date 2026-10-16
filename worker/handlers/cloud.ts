import { jsonResponse, HttpError, readJsonBody, assertSameOrigin } from '../http'
import { randomId } from '../id'
import { hitCloudWriteLimit } from '../ratelimit'
import { validateLevelDoc } from '../schema'
import { findProtoViolation } from '../sanitize'
import { requireUser } from '../session'
import type { RouteContext } from '../router'
import type { D1Database } from '../types'

/**
 * 云盘 API（docs/31 §5.2，批次 B2；docs/39 H2 扩展文件夹）：
 * 私有云盘域，槽位合并口径 = 关卡槽位数 + Σ(文件夹内含关卡数)，上限 CLOUD_LIMIT。
 * (user_id, level_id)/(user_id, folder_id) 唯一——POST 按资源 id upsert（覆盖更新不占新槽位）；
 * 所有按槽位 id 的读/写/删都限定 user_id，他人资源一律 404 防探测。
 */
export const CLOUD_LIMIT = 10
/** payload 序列化后字节上限（实测关卡 10–25KB，20 倍余量） */
export const MAX_PAYLOAD_BYTES = 512 * 1024
/** 请求体上限 = payload 上限 + 信封/转义余量 */
const BODY_MAX_BYTES = 560 * 1024

export const LEVEL_ID_RE = /^res_[0-9A-HJKMNP-TV-Z]{26}$/
const encoder = new TextEncoder()

function nowMs(): number {
  return Date.now()
}

interface CloudMetaRow {
  id: string
  level_id: string
  title: string
  bytes: number
  schema_version: number
  created_at: number
  updated_at: number
}

function toMeta(row: CloudMetaRow) {
  return {
    id: row.id,
    levelId: row.level_id,
    title: row.title,
    bytes: Number(row.bytes),
    schemaVersion: Number(row.schema_version),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export interface CloudFolderMetaRow {
  id: string
  folder_id: string
  title: string
  level_count: number
  bytes: number
  created_at: number
  updated_at: number
}

export function toFolderMeta(row: CloudFolderMetaRow) {
  return {
    id: row.id,
    folderId: row.folder_id,
    title: row.title,
    levelCount: Number(row.level_count),
    bytes: Number(row.bytes),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

export function readLevelId(body: Record<string, unknown>): string {
  const value = body.levelId
  if (typeof value !== 'string' || !LEVEL_ID_RE.test(value)) {
    throw new HttpError(400, 'bad_request', 'levelId 必须是合法的关卡资源 id（res_*）')
  }
  return value
}

/** 标题：NFC + trim，超长截断到 64 字符（不拒绝——宽容输入） */
export function readTitle(body: Record<string, unknown>): string {
  const raw = body.title
  if (typeof raw !== 'string') throw new HttpError(400, 'bad_request', 'title 必须是字符串')
  const value = raw.normalize('NFC').trim()
  return [...value].slice(0, 64).join('')
}

export function readPayload(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new HttpError(400, 'bad_request', 'payload 必须是关卡 JSON 对象')
  }
  return payload as Record<string, unknown>
}

/** 校验 + 序列化：proto 键 → schema → 体积，三道闸顺序执行；expectLevelId 用于槽位一致性检查 */
export function serializePayload(payload: Record<string, unknown>, expectLevelId?: string): { text: string; bytes: number; schemaVersion: number } {
  const protoKey = findProtoViolation(payload)
  if (protoKey) throw new HttpError(400, 'bad_request', `payload 含有不被允许的键：${protoKey}`)
  const check = validateLevelDoc(payload)
  if (!check.ok) {
    throw new HttpError(400, 'invalid_level', `关卡未通过信封校验：${check.errors.join('；')}`)
  }
  if (expectLevelId !== undefined && (payload as { id?: unknown }).id !== expectLevelId) {
    throw new HttpError(400, 'bad_request', `payload.id 与 levelId 不一致（${String((payload as { id?: unknown }).id)} ≠ ${expectLevelId}）`)
  }
  const text = JSON.stringify(payload)
  const bytes = encoder.encode(text).length
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new HttpError(413, 'too_large', `关卡超过体积上限（${MAX_PAYLOAD_BYTES} 字节）`)
  }
  return { text, bytes, schemaVersion: Number((payload as { schemaVersion?: unknown }).schemaVersion) }
}

/** GET /api/cloud/levels：槽位列表（元数据，不含 payload；H2 起并入文件夹与合并口径 used） */
export async function listLevels({ req, env }: RouteContext): Promise<Response> {
  const session = await requireUser(env.DB, req, nowMs())
  const result = await env.DB
    .prepare('SELECT id, level_id, title, bytes, schema_version, created_at, updated_at FROM cloud_levels WHERE user_id = ? ORDER BY updated_at DESC')
    .bind(session.user.id)
    .all<CloudMetaRow>()
  const levels = (result.results ?? []).map(toMeta)
  const folders = await env.DB
    .prepare('SELECT id, folder_id, title, level_count, bytes, created_at, updated_at FROM cloud_folders WHERE user_id = ? ORDER BY updated_at DESC')
    .bind(session.user.id)
    .all<CloudFolderMetaRow>()
  return jsonResponse({
    levels,
    folders: (folders.results ?? []).map(toFolderMeta),
    used: await countSlots(env.DB, session.user.id),
    limit: CLOUD_LIMIT,
  })
}

/** POST /api/cloud/levels：上传/覆盖（按 levelId upsert） */
export async function uploadLevel({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, BODY_MAX_BYTES)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const lockedSeconds = await hitCloudWriteLimit(env.DB, session.user.id, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `操作过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  const levelId = readLevelId(body)
  const title = readTitle(body)
  const { text, bytes, schemaVersion } = serializePayload(readPayload(body), levelId)
  const db = env.DB

  const existing = await db.prepare('SELECT id FROM cloud_levels WHERE user_id = ? AND level_id = ?').bind(session.user.id, levelId).first<{ id: string }>()
  if (existing) {
    await db
      .prepare('UPDATE cloud_levels SET title = ?, payload = ?, bytes = ?, schema_version = ?, updated_at = ? WHERE user_id = ? AND level_id = ?')
      .bind(title, text, bytes, schemaVersion, now, session.user.id, levelId)
      .run()
    const row = await db
      .prepare('SELECT id, level_id, title, bytes, schema_version, created_at, updated_at FROM cloud_levels WHERE id = ? AND user_id = ?')
      .bind(existing.id, session.user.id)
      .first<CloudMetaRow>()
    return jsonResponse({ level: row ? toMeta(row) : null, used: await countSlots(db, session.user.id) })
  }
  const used = await countSlots(db, session.user.id)
  if (used >= CLOUD_LIMIT) {
    throw new HttpError(409, 'cloud_full', `云盘已满（${CLOUD_LIMIT} 个槽位）——请先删除不再需要的关卡`)
  }
  const id = randomId('cld')
  await db
    .prepare('INSERT INTO cloud_levels (id, user_id, level_id, title, payload, bytes, schema_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, session.user.id, levelId, title, text, bytes, schemaVersion, now, now)
    .run()
  return jsonResponse({ level: { id, levelId, title, bytes, schemaVersion, createdAt: now, updatedAt: now }, used: used + 1 }, 201)
}

/** 槽位合并口径（docs/39 H2）：关卡槽位数 + Σ(文件夹内含关卡数） */
export async function countSlots(db: D1Database, userId: string): Promise<number> {
  const lv = await db.prepare('SELECT COUNT(*) AS n FROM cloud_levels WHERE user_id = ?').bind(userId).first<{ n: number }>()
  const fd = await db.prepare('SELECT COALESCE(SUM(level_count), 0) AS n FROM cloud_folders WHERE user_id = ?').bind(userId).first<{ n: number }>()
  return Number(lv?.n ?? 0) + Number(fd?.n ?? 0)
}

async function loadOwnedSlot(db: D1Database, slotId: string, userId: string): Promise<CloudMetaRow & { payload: string }> {
  const row = await db
    .prepare('SELECT id, user_id, level_id, title, payload, bytes, schema_version, created_at, updated_at FROM cloud_levels WHERE id = ? AND user_id = ?')
    .bind(slotId, userId)
    .first<CloudMetaRow & { payload: string }>()
  if (!row) throw new HttpError(404, 'not_found', '云端槽位不存在')
  return row
}

/** GET /api/cloud/levels/:id：下载（含 payload） */
export async function getLevel({ req, env, params }: RouteContext): Promise<Response> {
  const session = await requireUser(env.DB, req, nowMs())
  const row = await loadOwnedSlot(env.DB, params.id ?? '', session.user.id)
  let payload: unknown = null
  try {
    payload = JSON.parse(row.payload)
  } catch {
    throw new HttpError(500, 'internal', '云端数据损坏，请联系管理员')
  }
  return jsonResponse({ level: { ...toMeta(row), payload } })
}

/** PUT /api/cloud/levels/:id：按槽位覆盖（payload + title 全量替换，levelId 不变） */
export async function replaceLevel({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const body = await readJsonBody(req, BODY_MAX_BYTES)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const lockedSeconds = await hitCloudWriteLimit(env.DB, session.user.id, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `操作过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  const title = readTitle(body)
  const { text, bytes, schemaVersion } = serializePayload(readPayload(body))
  const existing = await loadOwnedSlot(env.DB, params.id ?? '', session.user.id)
  if ((JSON.parse(text) as { id?: unknown }).id !== existing.level_id) {
    throw new HttpError(400, 'bad_request', `payload.id 与该槽位的关卡不一致（${existing.level_id}）`)
  }
  await env.DB
    .prepare('UPDATE cloud_levels SET title = ?, payload = ?, bytes = ?, schema_version = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .bind(title, text, bytes, schemaVersion, now, existing.id, session.user.id)
    .run()
  return jsonResponse({ level: { ...toMeta(existing), title, bytes, schemaVersion, updatedAt: now } })
}

/** DELETE /api/cloud/levels/:id */
export async function deleteLevel({ req, env, params }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const now = nowMs()
  const session = await requireUser(env.DB, req, now)
  const lockedSeconds = await hitCloudWriteLimit(env.DB, session.user.id, now)
  if (lockedSeconds > 0) {
    throw new HttpError(429, 'rate_limited', `操作过于频繁，请 ${Math.max(1, Math.ceil(lockedSeconds / 60))} 分钟后再试`)
  }
  const existing = await loadOwnedSlot(env.DB, params.id ?? '', session.user.id)
  // 源绑定锁定（docs/39 §3）：pending/published 期间不可删源；rejected 不锁
  const lock = await env.DB
    .prepare("SELECT id, status, submitter_id FROM hub_items WHERE scope = 'public' AND root_doc_id = ?")
    .bind(existing.level_id)
    .first<{ status: string }>()
  if (lock && (lock.status === 'pending' || lock.status === 'published')) {
    throw new HttpError(409, 'publish_locked', '该关卡有进行中的公开申请或已公开——请先撤回，再删除')
  }
  await env.DB.prepare('DELETE FROM cloud_levels WHERE id = ? AND user_id = ?').bind(existing.id, session.user.id).run()
  return jsonResponse({ ok: true })
}
