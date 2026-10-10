import { HttpError } from './http'
import { findUserById, toApiUser } from './users'
import type { ApiUser, D1Database } from './types'

/**
 * 会话（docs/31 §6.2）：不透明随机 token 放 Cookie，DB 只存 SHA-256(token)——
 * 库被拖走也无法伪造会话。Cookie HttpOnly + Secure + SameSite=Lax，
 * 30 天滑动续期（余量 <15 天时刷新）。
 */
export const SESSION_COOKIE = 'mp_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const RENEW_THRESHOLD_MS = 15 * 24 * 60 * 60 * 1000

export interface ResolvedSession {
  user: ApiUser
  tokenHash: string
  expiresAt: number
}

const encoder = new TextEncoder()

async function sha256Hex(input: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(input))
  let hex = ''
  for (const b of new Uint8Array(bytes)) hex += b.toString(16).padStart(2, '0')
  return hex
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`
}

function tokenFromCookie(req: Request): string | null {
  const header = req.headers.get('Cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      const value = part.slice(eq + 1).trim()
      return value === '' ? null : value
    }
  }
  return null
}

export async function createSession(db: D1Database, userId: string, now: number): Promise<{ token: string; tokenHash: string }> {
  const token = randomToken()
  const tokenHash = await sha256Hex(token)
  await db
    .prepare('INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(tokenHash, userId, now, now, now + SESSION_TTL_MS)
    .run()
  return { token, tokenHash }
}

export async function resolveSession(db: D1Database, req: Request, now: number): Promise<ResolvedSession | null> {
  const token = tokenFromCookie(req)
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await db
    .prepare('SELECT id, user_id, created_at, last_seen_at, expires_at FROM sessions WHERE id = ?')
    .bind(tokenHash)
    .first<{ user_id: string; expires_at: number }>()
  if (!row) return null
  if (Number(row.expires_at) <= now) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(tokenHash).run()
    return null
  }
  const user = await findUserById(db, String(row.user_id))
  if (!user || user.status !== 'active') return null
  let expiresAt = Number(row.expires_at)
  if (expiresAt - now < RENEW_THRESHOLD_MS) {
    expiresAt = now + SESSION_TTL_MS
    await db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').bind(now, expiresAt, tokenHash).run()
  }
  return { user: toApiUser(user), tokenHash, expiresAt }
}

/** 认证守卫：未登录/会话失效一律 401（handler 内直接 await） */
export async function requireUser(db: D1Database, req: Request, now: number): Promise<ResolvedSession> {
  const session = await resolveSession(db, req, now)
  if (!session) throw new HttpError(401, 'unauthorized', '请先登录')
  return session
}

export async function revokeSession(db: D1Database, req: Request): Promise<void> {
  const token = tokenFromCookie(req)
  if (!token) return
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run()
}

/** 改密后吊销该用户其余会话（保留当前登录态） */
export async function revokeOtherSessions(db: D1Database, userId: string, keepTokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(userId, keepTokenHash).run()
}

/** 概率性清理过期会话行（挂在登录成功路径，避免定时任务与写放大） */
export async function maybeCleanupSessions(db: D1Database, now: number): Promise<void> {
  if (Math.random() >= 0.1) return
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run()
}
