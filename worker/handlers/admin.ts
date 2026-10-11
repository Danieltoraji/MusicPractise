import { jsonResponse, HttpError, readJsonBody } from '../http'
import { hashPassword } from '../password'
import { requireAdmin, writeAudit } from '../admin'
import { findUserById, findUserByNickname, updateUserNickname, updateUserPassword } from '../users'
import { checkNickname, checkPassword } from '../validate'
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
