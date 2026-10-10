import { describe, expect, it } from 'vitest'
import { D1Fake } from './testhelpers/d1fake'
import {
  clearSessionCookie,
  createSession,
  maybeCleanupSessions,
  requireUser,
  resolveSession,
  revokeOtherSessions,
  revokeSession,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
} from './session'

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

function seedUser(db: D1Fake, overrides: Partial<{ id: string; status: string }> = {}): void {
  db.seedUser({
    id: overrides.id ?? 'usr_A',
    nickname: '阿明',
    pw_hash: 'pbkdf2$100000$a$b',
    role: 'user',
    status: overrides.status ?? 'active',
    created_at: NOW,
    updated_at: NOW,
  })
}

function requestWithCookie(token: string): Request {
  return new Request('http://localhost/api/auth/me', { headers: { Cookie: `${SESSION_COOKIE}=${token}` } })
}

describe('会话（D1 fake，docs/31 §6.2）', () => {
  it('Cookie 构造：HttpOnly + Secure + SameSite=Lax + 30 天 Max-Age；清除态 Max-Age=0', () => {
    const cookie = sessionCookie('tok')
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
    expect(clearSessionCookie()).toContain('Max-Age=0')
  })

  it('create → resolve 往返；余量充足时不续期', async () => {
    const db = new D1Fake()
    seedUser(db)
    const { token, tokenHash } = await createSession(db, 'usr_A', NOW)
    expect(token).not.toContain('=')
    expect(db.sessions).toEqual([expect.objectContaining({ id: tokenHash, user_id: 'usr_A' })])

    const resolved = await resolveSession(db, requestWithCookie(token), NOW + 1000)
    expect(resolved?.user).toEqual({ id: 'usr_A', nickname: '阿明', role: 'user' })
    expect(resolved?.expiresAt).toBe(NOW + SESSION_TTL_MS)
    expect(db.executedSql.some((sql) => sql.startsWith('UPDATE sessions'))).toBe(false)
  })

  it('余量 <15 天触发滑动续期：expiresAt 顺延满 30 天', async () => {
    const db = new D1Fake()
    seedUser(db)
    const { token } = await createSession(db, 'usr_A', NOW)
    const later = NOW + 20 * DAY
    const resolved = await resolveSession(db, requestWithCookie(token), later)
    expect(resolved?.expiresAt).toBe(later + SESSION_TTL_MS)
  })

  it('过期会话：resolve 返回 null 且删除该行', async () => {
    const db = new D1Fake()
    seedUser(db)
    const { token } = await createSession(db, 'usr_A', NOW)
    const past = NOW + SESSION_TTL_MS + 1
    expect(await resolveSession(db, requestWithCookie(token), past)).toBeNull()
    expect(db.sessions).toHaveLength(0)
  })

  it('未知 token / 无 Cookie / 用户被禁用 → null', async () => {
    const db = new D1Fake()
    expect(await resolveSession(db, requestWithCookie('nope'), NOW)).toBeNull()
    expect(await resolveSession(db, new Request('http://localhost/'), NOW)).toBeNull()

    seedUser(db, { status: 'disabled' })
    const { token } = await createSession(db, 'usr_A', NOW)
    expect(await resolveSession(db, requestWithCookie(token), NOW)).toBeNull()
  })

  it('requireUser：未登录抛 401 HttpError', async () => {
    const db = new D1Fake()
    await expect(requireUser(db, new Request('http://localhost/'), NOW)).rejects.toMatchObject({
      status: 401,
      code: 'unauthorized',
    })
  })

  it('revokeSession 删除当前会话；revokeOtherSessions 保留指定会话', async () => {
    const db = new D1Fake()
    seedUser(db)
    const a = await createSession(db, 'usr_A', NOW)
    const b = await createSession(db, 'usr_A', NOW)
    expect(db.sessions.map((s) => s.id).sort()).toEqual([a.tokenHash, b.tokenHash].sort())

    await revokeOtherSessions(db, 'usr_A', b.tokenHash)
    expect(db.sessions.map((s) => s.id)).toEqual([b.tokenHash])

    await revokeSession(db, requestWithCookie(b.token))
    expect(db.sessions).toHaveLength(0)
  })

  it('maybeCleanupSessions：清理已过期行（强制概率路径）', async () => {
    const db = new D1Fake()
    seedUser(db)
    const { tokenHash } = await createSession(db, 'usr_A', NOW)
    // 直接把该会话行改过期，再强制走清理（Math.random 桩为必中）
    const realRandom = Math.random
    Math.random = () => 0
    try {
      db.sessions[0].expires_at = NOW - 1
      await maybeCleanupSessions(db, NOW)
    } finally {
      Math.random = realRandom
    }
    expect(db.sessions.find((s) => s.id === tokenHash)).toBeUndefined()
  })
})
