import { jsonResponse, HttpError, readJsonBody, assertSameOrigin } from '../http'
import { randomId } from '../id'
import { hashPassword } from '../password'
import { requireAdmin, writeAudit } from '../admin'
import { findUserById, findUserByNickname, updateUserNickname, updateUserPassword } from '../users'
import { checkNickname, checkPassword } from '../validate'
import { readLevelId, readTitle, serializePayload, readPayload } from './cloud'
import { parseFolderBody, checkClosure } from './cloud_folders'
import type { RouteContext } from '../router'

/**
 * 管理后台 API（docs/31 §5.4，批次 B4）：全部经 requireAdmin（非 admin 一律 403）。
 * 防自锁：PATCH/DELETE 目标是自己时整体 400（改自己走设置页既有通道）。
 * 逐操作写审计（detail 只存变更摘要，绝不含密码）。
 */
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function nowMs(): number {
  return Date.now()
}

function paging(url: URL): { limit: number; offset: number; query: string } {
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  const offset = Math.max(Number(url.searchParams.get('offset')) || 0, 0)
  const query = (url.searchParams.get('query') ?? '').trim().slice(0, 64)
  return { limit, offset, query }
}

function readField(body: Record<string, unknown>, key: string, check: (v: unknown) => { ok: true; value: string } | { ok: false; message: string }): string {
  const result = check(body[key])
  if (!result.ok) throw new HttpError(400, 'bad_request', result.message)
  return result.value
}

/** GET /api/admin/stats：用户数 / 云盘关卡数 / 活跃会话数 */
export async function adminStats({ req, env }: RouteContext): Promise<Response> {
  const now = nowMs()
  await requireAdmin(env.DB, req, now)
  const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
  const levels = await env.DB.prepare('SELECT COUNT(*) AS n FROM cloud_levels').first<{ n: number }>()
  const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').bind(now).first<{ n: number }>()
  return jsonResponse({ users: Number(users?.n ?? 0), cloudLevels: Number(levels?.n ?? 0), activeSessions: Number(sessions?.n ?? 0) })
}

/** GET /api/admin/users?query=&limit=&offset=：用户列表（LIKE 搜昵称） */
export async function adminListUsers({ req, env }: RouteContext): Promise<Response> {
  await requireAdmin(env.DB, req, nowMs())
  const { limit, offset, query } = paging(new URL(req.url))
  const pattern = `%${query}%`
  const result = await env.DB
    .prepare('SELECT id, nickname, role, status, created_at FROM users WHERE nickname LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .bind(pattern, limit, offset)
    .all<{ id: string; nickname: string; role: 'user' | 'admin'; status: 'active' | 'disabled'; created_at: number }>()
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE nickname LIKE ?').bind(pattern).first<{ n: number }>()
  const users = (result.results ?? []).map((r) => ({ id: r.id, nickname: r.nickname, role: r.role, status: r.status, createdAt: Number(r.created_at) }))
  return jsonResponse({ users, total: Number(total?.n ?? 0), limit, offset })
}

/** PATCH /api/admin/users/:id：改昵称/禁用·启用/调角色/重置密码（可一次多项） */
export async function adminPatchUser({ req, env, params }: RouteContext): Promise<Response> {
  const body = await readJsonBody(req, 16 * 1024)
  const now = nowMs()
  const admin = await requireAdmin(env.DB, req, now)
  const target = await findUserById(env.DB, params.id ?? '')
  if (!target) throw new HttpError(404, 'not_found', '用户不存在')
  if (target.id === admin.user.id) {
    throw new HttpError(400, 'cannot_modify_self', '不能通过管理接口修改自己（请使用设置页）')
  }

  const detail: Record<string, unknown> = {}
  if (body.nickname !== undefined) {
    const nickname = readField(body, 'nickname', checkNickname)
    const existing = await findUserByNickname(env.DB, nickname)
    if (existing && existing.id !== target.id) throw new HttpError(409, 'nickname_taken', '昵称已被占用')
    await updateUserNickname(env.DB, target.id, nickname, now)
    detail.nickname = nickname
  }
  if (body.status !== undefined) {
    if (body.status !== 'active' && body.status !== 'disabled') throw new HttpError(400, 'bad_request', 'status 必须是 active 或 disabled')
    await env.DB.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').bind(body.status, now, target.id).run()
    if (body.status === 'disabled') {
      // 禁用即强制下线：吊销目标全部会话
      await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run()
    }
    detail.status = body.status
  }
  if (body.role !== undefined) {
    if (body.role !== 'user' && body.role !== 'admin') throw new HttpError(400, 'bad_request', 'role 必须是 user 或 admin')
    await env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ?').bind(body.role, now, target.id).run()
    detail.role = body.role
  }
  if (body.newPassword !== undefined) {
    const newPassword = readField(body, 'newPassword', checkPassword)
    await updateUserPassword(env.DB, target.id, await hashPassword(newPassword), now)
    // 重置密码后吊销目标全部会话（其当前登录一并失效）
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run()
    detail.passwordReset = true
  }
  if (Object.keys(detail).length === 0) {
    throw new HttpError(400, 'bad_request', '没有需要变更的字段（nickname/status/role/newPassword 至少一项）')
  }
  await writeAudit(env.DB, { actorId: admin.user.id, action: 'admin.patch_user', targetType: 'user', targetId: target.id, detail }, now)
  const updated = await findUserById(env.DB, target.id)
  return jsonResponse({ user: updated ? { id: updated.id, nickname: updated.nickname, role: updated.role, status: updated.status } : null })
}

/** DELETE /api/admin/users/:id：删除用户（显式级联清理会话/云盘/进度） */
export async function adminDeleteUser({ req, env, params }: RouteContext): Promise<Response> {
  const now = nowMs()
  const admin = await requireAdmin(env.DB, req, now)
  const target = await findUserById(env.DB, params.id ?? '')
  if (!target) throw new HttpError(404, 'not_found', '用户不存在')
  if (target.id === admin.user.id) {
    throw new HttpError(400, 'cannot_delete_self', '不能删除自己的账号')
  }
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id).run()
  await env.DB.prepare('DELETE FROM cloud_levels WHERE user_id = ?').bind(target.id).run()
  await env.DB.prepare('DELETE FROM progress WHERE user_id = ?').bind(target.id).run()
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target.id).run()
  await writeAudit(env.DB, { actorId: admin.user.id, action: 'admin.delete_user', targetType: 'user', targetId: target.id, detail: { nickname: target.nickname } }, now)
  return jsonResponse({ ok: true })
}

/** GET /api/admin/levels?query=&limit=&offset=：全站云盘关卡（含属主昵称） */
export async function adminListLevels({ req, env }: RouteContext): Promise<Response> {
  await requireAdmin(env.DB, req, nowMs())
  const { limit, offset, query } = paging(new URL(req.url))
  const pattern = `%${query}%`
  const result = await env.DB
    .prepare(
      'SELECT c.id, c.user_id, c.level_id, c.title, c.bytes, c.schema_version, c.created_at, c.updated_at, u.nickname AS owner_nickname ' +
        'FROM cloud_levels c JOIN users u ON u.id = c.user_id WHERE c.title LIKE ? ORDER BY c.updated_at DESC LIMIT ? OFFSET ?',
    )
    .bind(pattern, limit, offset)
    .all<{ id: string; user_id: string; level_id: string; title: string; bytes: number; schema_version: number; created_at: number; updated_at: number; owner_nickname: string }>()
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM cloud_levels c JOIN users u ON u.id = c.user_id WHERE c.title LIKE ?').bind(pattern).first<{ n: number }>()
  const levels = (result.results ?? []).map((r) => ({
    id: r.id,
    levelId: r.level_id,
    title: r.title,
    ownerNickname: r.owner_nickname,
    bytes: Number(r.bytes),
    updatedAt: Number(r.updated_at),
  }))
  return jsonResponse({ levels, total: Number(total?.n ?? 0), limit, offset })
}

/** DELETE /api/admin/levels/:id：删除违规关卡（不限属主） */
export async function adminDeleteLevel({ req, env, params }: RouteContext): Promise<Response> {
  const now = nowMs()
  const admin = await requireAdmin(env.DB, req, now)
  const row = await env.DB.prepare('SELECT id, user_id, title FROM cloud_levels WHERE id = ?').bind(params.id ?? '').first<{ id: string; user_id: string; title: string }>()
  if (!row) throw new HttpError(404, 'not_found', '云端槽位不存在')
  await env.DB.prepare('DELETE FROM cloud_levels WHERE id = ?').bind(row.id).run()
  await writeAudit(env.DB, { actorId: admin.user.id, action: 'admin.delete_level', targetType: 'cloud_level', targetId: row.id, detail: { title: row.title, ownerId: row.user_id } }, now)
  return jsonResponse({ ok: true })
}

/** GET /api/admin/audit?limit=&offset=：审计日志倒序分页（操作者已注销显示空昵称） */
export async function adminListAudit({ req, env }: RouteContext): Promise<Response> {
  await requireAdmin(env.DB, req, nowMs())
  const { limit, offset } = paging(new URL(req.url))
  const result = await env.DB
    .prepare(
      'SELECT a.id, a.actor_id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.nickname AS actor_nickname ' +
        'FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT ? OFFSET ?',
    )
    .bind(limit, offset)
    .all<{ id: string; actor_id: string | null; action: string; target_type: string; target_id: string; detail: string | null; created_at: number; actor_nickname: string | null }>()
  const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log').first<{ n: number }>()
  const entries = (result.results ?? []).map((r) => ({
    id: r.id,
    actorNickname: r.actor_nickname,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    detail: r.detail === null ? null : (JSON.parse(r.detail) as Record<string, unknown>),
    createdAt: Number(r.created_at),
  }))
  return jsonResponse({ entries, total: Number(total?.n ?? 0), limit, offset })
}

// ---------------------------------------------------------------------------
// 关卡库审核（docs/39 §5.2，批次 H3）：队列 / 批准 / 驳回；逐操作写审计。
// ---------------------------------------------------------------------------

interface HubItemRow {
  id: string
  scope: string
  item_kind: string
  root_doc_id: string
  title: string
  level_count: number
  bytes: number
  submitter_name: string
  submitter_note: string | null
  want_featured: number
  status: string
  featured: number
  reject_reason: string | null
  created_at: number
  updated_at: number
}

function toHubAdminMeta(r: HubItemRow) {
  return {
    id: r.id,
    scope: r.scope,
    itemKind: r.item_kind,
    rootDocId: r.root_doc_id,
    title: r.title,
    levelCount: Number(r.level_count),
    bytes: Number(r.bytes),
    submitterName: r.submitter_name,
    submitterNote: r.submitter_note,
    wantFeatured: Number(r.want_featured) === 1,
    status: r.status,
    featured: Number(r.featured) === 1,
    rejectReason: r.reject_reason,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

const HUB_COLS =
  'id, scope, item_kind, root_doc_id, title, level_count, bytes, submitter_name, submitter_note, want_featured, status, featured, reject_reason, created_at, updated_at'

const HUB_STATUSES = ['pending', 'published', 'rejected']

/** GET /api/admin/hub?status=&query=&limit=&offset=：审核队列（默认 pending） */
export async function adminListHub({ req, env }: RouteContext): Promise<Response> {
  await requireAdmin(env.DB, req, nowMs())
  const url = new URL(req.url)
  const { limit, offset, query } = paging(url)
  const statusParam = (url.searchParams.get('status') ?? 'pending').trim()
  if (!HUB_STATUSES.includes(statusParam)) throw new HttpError(400, 'bad_request', 'status 必须是 pending/published/rejected')
  const pattern = `%${query}%`
  const hasQuery = query !== ''
  const list = hasQuery
    ? await env.DB
        .prepare(`SELECT ${HUB_COLS} FROM hub_items WHERE status = ? AND title LIKE ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
        .bind(statusParam, pattern, limit, offset)
        .all<HubItemRow>()
    : await env.DB.prepare(`SELECT ${HUB_COLS} FROM hub_items WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`).bind(statusParam, limit, offset).all<HubItemRow>()
  const total = hasQuery
    ? await env.DB.prepare('SELECT COUNT(*) AS n FROM hub_items WHERE status = ? AND title LIKE ?').bind(statusParam, pattern).first<{ n: number }>()
    : await env.DB.prepare('SELECT COUNT(*) AS n FROM hub_items WHERE status = ?').bind(statusParam).first<{ n: number }>()
  return jsonResponse({ items: (list.results ?? []).map(toHubAdminMeta), total: Number(total?.n ?? 0), limit, offset })
}

/** POST /api/admin/hub/:id/approve {featured?}：批准公开（可同时授予精选） */
export async function adminApproveHub({ req, env, params }: RouteContext): Promise<Response> {
  const now = nowMs()
  const session = await requireAdmin(env.DB, req, now)
  const body = await readJsonBody(req, 16 * 1024).catch(() => ({}) as Record<string, unknown>)
  const featured = (body as Record<string, unknown>).featured === true
  const db = env.DB
  const row = await db.prepare('SELECT id, submitter_id, status FROM hub_items WHERE id = ?').bind(params.id ?? '').first<{ id: string; status: string }>()
  if (!row) throw new HttpError(404, 'not_found', '条目不存在')
  if (row.status !== 'pending') throw new HttpError(409, 'not_pending', '该条目不在待审核状态')
  await db
    .prepare("UPDATE hub_items SET status = 'published', featured = ?, reviewed_by = ?, reviewed_at = ?, published_at = ?, updated_at = ? WHERE id = ?")
    .bind(featured ? 1 : 0, session.user.id, now, now, now, row.id)
    .run()
  const item = await db.prepare('SELECT title, submitter_name FROM hub_items WHERE id = ?').bind(row.id).first<{ title: string; submitter_name: string }>()
  await writeAudit(db, { actorId: session.user.id, action: 'hub.approve', targetType: 'hub_item', targetId: row.id, detail: { title: item?.title, submitter: item?.submitter_name, featured } }, now)
  return jsonResponse({ ok: true, status: 'published', featured })
}

/** POST /api/admin/hub/:id/reject {reason}：驳回（附理由；驳回即解锁源槽位） */
export async function adminRejectHub({ req, env, params }: RouteContext): Promise<Response> {
  const now = nowMs()
  const session = await requireAdmin(env.DB, req, now)
  const body = (await readJsonBody(req, 16 * 1024)) as Record<string, unknown>
  const reason = readField(body, 'reason', (v) =>
    typeof v === 'string' && v.normalize('NFC').trim() !== '' ? { ok: true, value: v.normalize('NFC').trim().slice(0, 200) } : { ok: false, message: 'reason 必须是非空字符串（≤200 字）' },
  )
  const db = env.DB
  const row = await db.prepare('SELECT id, submitter_id, status FROM hub_items WHERE id = ?').bind(params.id ?? '').first<{ id: string; status: string }>()
  if (!row) throw new HttpError(404, 'not_found', '条目不存在')
  if (row.status !== 'pending') throw new HttpError(409, 'not_pending', '该条目不在待审核状态')
  await db
    .prepare("UPDATE hub_items SET status = 'rejected', reject_reason = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?")
    .bind(reason, session.user.id, now, now, row.id)
    .run()
  const item = await db.prepare('SELECT title, submitter_name FROM hub_items WHERE id = ?').bind(row.id).first<{ title: string; submitter_name: string }>()
  await writeAudit(db, { actorId: session.user.id, action: 'hub.reject', targetType: 'hub_item', targetId: row.id, detail: { title: item?.title, submitter: item?.submitter_name, reason } }, now)
  return jsonResponse({ ok: true, status: 'rejected' })
}

/** 官方库条目上限（docs/39 §3 额度模型）：防 D1 膨胀 */
export const OFFICIAL_MAX = 200

/** PATCH /api/admin/hub/:id {featured}：随时指定/取消精选（仅 published；官方条目无精选语义） */
export async function adminPatchHubFeatured({ req, env, params }: RouteContext): Promise<Response> {
  const now = nowMs()
  const session = await requireAdmin(env.DB, req, now)
  const body = (await readJsonBody(req, 16 * 1024)) as Record<string, unknown>
  const featured = body.featured
  if (typeof featured !== 'boolean') throw new HttpError(400, 'bad_request', 'featured 必须是布尔值')
  const db = env.DB
  const row = await db.prepare('SELECT id, status FROM hub_items WHERE id = ?').bind(params.id ?? '').first<{ id: string; status: string }>()
  if (!row) throw new HttpError(404, 'not_found', '条目不存在')
  if (row.status !== 'published') throw new HttpError(409, 'not_published', '仅已发布的条目可设置精选')
  await db.prepare('UPDATE hub_items SET featured = ?, updated_at = ? WHERE id = ?').bind(featured ? 1 : 0, now, row.id).run()
  const item = await db.prepare('SELECT title FROM hub_items WHERE id = ?').bind(row.id).first<{ title: string }>()
  await writeAudit(db, { actorId: session.user.id, action: 'hub.set_featured', targetType: 'hub_item', targetId: row.id, detail: { title: item?.title, featured } }, now)
  return jsonResponse({ ok: true, featured })
}

/** DELETE /api/admin/hub/:id：移除任一条目（快照与文档一并删除；源槽位随之解锁） */
export async function adminDeleteHub({ req, env, params }: RouteContext): Promise<Response> {
  const now = nowMs()
  const session = await requireAdmin(env.DB, req, now)
  const db = env.DB
  const row = await db.prepare('SELECT id FROM hub_items WHERE id = ?').bind(params.id ?? '').first<{ id: string }>()
  if (!row) throw new HttpError(404, 'not_found', '条目不存在')
  const item = await db.prepare('SELECT title, submitter_name, status FROM hub_items WHERE id = ?').bind(row.id).first<{ title: string; submitter_name: string; status: string }>()
  await db.batch([
    db.prepare('DELETE FROM hub_item_docs WHERE item_id = ?').bind(row.id),
    db.prepare('DELETE FROM hub_items WHERE id = ?').bind(row.id),
  ])
  await writeAudit(db, { actorId: session.user.id, action: 'hub.delete', targetType: 'hub_item', targetId: row.id, detail: { title: item?.title, submitter: item?.submitter_name, status: item?.status } }, now)
  return jsonResponse({ ok: true })
}

/** POST /api/admin/hub/official：直传官方条目（单关 {levelId,title,payload} 或系列包 {folderId,title,docs}）；
 *  直接 published，submitter 空、昵称快照「官方」；同 root 重复上传 = 覆盖更新。 */
export async function adminCreateOfficial({ req, env }: RouteContext): Promise<Response> {
  assertSameOrigin(req)
  const now = nowMs()
  const session = await requireAdmin(env.DB, req, now)
  const db = env.DB
  const count = await db.prepare("SELECT COUNT(*) AS n FROM hub_items WHERE scope = 'official'").first<{ n: number }>()
  if (Number(count?.n ?? 0) >= OFFICIAL_MAX) {
    throw new HttpError(409, 'official_full', `官方库已满（${OFFICIAL_MAX} 条）——请先移除不再需要的条目`)
  }
  const body = await readJsonBody(req, 5.6 * 1024 * 1024)
  let rootDocId: string
  let itemKind: 'level' | 'series'
  let title: string
  let levelCount: number
  let bytes: number
  let docs: { doc_id: string; kind: string; payload: string; bytes: number }[]
  if (body.payload !== undefined) {
    // 单关形态（与云盘关卡上传同契约）
    const levelId = readLevelId(body)
    title = readTitle(body)
    const { text, bytes: b } = serializePayload(readPayload(body), levelId)
    rootDocId = levelId
    itemKind = 'level'
    levelCount = 1
    bytes = b
    docs = [{ doc_id: levelId, kind: 'level', payload: text, bytes: b }]
  } else {
    // 系列包形态（与云盘文件夹上传同契约：闭包校验复用）
    const parsed = parseFolderBody(body)
    levelCount = checkClosure(parsed.docs)
    rootDocId = parsed.folderId
    itemKind = 'series'
    title = parsed.title
    bytes = parsed.docs.reduce((acc, d) => acc + d.bytes, 0)
    docs = parsed.docs.map((d) => ({ doc_id: d.id, kind: d.kind, payload: d.text, bytes: d.bytes }))
  }
  // 同内容在 public+official 视作同一命名空间（部分唯一索引口径）：
  // 公共域已存在 → 409 提示先移除；官方域已存在 → 覆盖更新
  const existing = await db
    .prepare("SELECT id, scope FROM hub_items WHERE root_doc_id = ? AND scope IN ('public', 'official')")
    .bind(rootDocId)
    .first<{ id: string; scope: string }>()
  if (existing && existing.scope === 'public') {
    throw new HttpError(409, 'already_in_public', '该内容已在公共关卡库——请先在「已发布」列表移除公共条目，再上传官方版本')
  }
  const id = existing?.id ?? randomId('hub')
  await db.batch([
    db.prepare('DELETE FROM hub_item_docs WHERE item_id = ?').bind(id),
    ...(existing ? [db.prepare('DELETE FROM hub_items WHERE id = ?').bind(id)] : []),
    db
      .prepare(
        'INSERT INTO hub_items (id, scope, item_kind, root_doc_id, title, level_count, bytes, submitter_id, submitter_name, submitter_note, want_featured, status, featured, reject_reason, reviewed_by, reviewed_at, published_at, downloads, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(id, 'official', itemKind, rootDocId, title, levelCount, bytes, null, '官方', null, 0, 'published', 0, null, null, null, now, 0, now, now),
    ...docs.map((d) =>
      db.prepare('INSERT INTO hub_item_docs (item_id, doc_id, kind, payload, bytes) VALUES (?, ?, ?, ?, ?)').bind(id, d.doc_id, d.kind, d.payload, d.bytes),
    ),
  ])
  await writeAudit(db, { actorId: session.user.id, action: 'hub.official_add', targetType: 'hub_item', targetId: id, detail: { title, itemKind, rootDocId, replaced: existing !== undefined } }, now)
  return jsonResponse({ ok: true, item: { id, itemKind, rootDocId, title, levelCount, status: 'published' } }, existing ? 200 : 201)
}
