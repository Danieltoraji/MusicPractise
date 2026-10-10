import { beforeEach, describe, expect, it } from 'vitest'
import handler from '../index'
import { D1Fake } from '../testhelpers/d1fake'
import type { Env, ExecutionContext } from '../types'

/**
 * 认证 API 集成测试（docs/31 §9）：走完整 fetch handler（Request → Response），
 * 含 Set-Cookie 往返；业务语义（限流窗口/会话续期/防枚举）已由模块单测覆盖，
 * 此处固化端到端行为与错误信封。
 */

const ORIGIN = 'http://localhost:8787'

function makeEnv(): { env: Env; db: D1Fake } {
  const db = new D1Fake()
  return {
    db,
    env: { DB: db, ASSETS: { fetch: async () => new Response('<html>spa</html>') }, IP_HASH_SALT: 'test' },
  }
}

const ctx: ExecutionContext = { waitUntil: () => {}, passThroughOnException: () => {} }

function post(path: string, body: unknown, opts: { cookie?: string; origin?: string } = {}): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.cookie) headers.Cookie = `mp_session=${opts.cookie}`
  headers.Origin = opts.origin ?? ORIGIN
  return new Request(`${ORIGIN}${path}`, { method: 'POST', body: JSON.stringify(body), headers })
}

function patch(path: string, body: unknown, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Cookie: `mp_session=${cookie}`, Origin: ORIGIN },
  })
}

function cookieOf(res: Response): string {
  const match = /mp_session=([^;]*)/.exec(res.headers.get('Set-Cookie') ?? '')
  expect(match, '响应应携带 mp_session Cookie').toBeTruthy()
  return match![1]
}

let env: Env
let db: D1Fake

beforeEach(() => {
  const made = makeEnv()
  env = made.env
  db = made.db
})

/** 注册并返回会话 cookie */
async function registerAndGetCookie(nickname = '小明', password = 'password-123'): Promise<string> {
  const res = await handler.fetch(post('/api/auth/register', { nickname, password }), env, ctx)
  expect(res.status).toBe(201)
  return cookieOf(res)
}

describe('认证 API（fetch handler 集成，docs/31 §5.1）', () => {
  it('注册成功：201 + user 形态 + Set-Cookie；密码以 pbkdf2 格式落库；绝不回传哈希', async () => {
    const res = await handler.fetch(post('/api/auth/register', { nickname: '小明', password: 'password-123' }), env, ctx)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { user: { id: string; nickname: string; role: string } }
    expect(body.user.nickname).toBe('小明')
    expect(body.user.role).toBe('user')
    expect(body.user.id).toMatch(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(JSON.stringify(body)).not.toContain('pw_hash')
    expect(res.headers.get('Set-Cookie')).toContain('HttpOnly')
    expect(db.users).toHaveLength(1)
    expect(String(db.users[0].pw_hash)).toMatch(/^pbkdf2\$/)
  })

  it('注册反例：昵称占用 409（含大小写变体）；昵称/密码不合法 400', async () => {
    await registerAndGetCookie('小明')
    const dup = await handler.fetch(post('/api/auth/register', { nickname: '小明', password: 'password-456' }), env, ctx)
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('nickname_taken')

    const dupCase = await handler.fetch(post('/api/auth/register', { nickname: '小明'.toUpperCase(), password: 'password-456' }), env, ctx)
    expect(dupCase.status).toBe(409)

    const badNick = await handler.fetch(post('/api/auth/register', { nickname: 'a', password: 'password-456' }), env, ctx)
    expect(badNick.status).toBe(400)
    const badPw = await handler.fetch(post('/api/auth/register', { nickname: '小红', password: 'short' }), env, ctx)
    expect(badPw.status).toBe(400)
  })

  it('登录 → me 往返；me 未登录返回 {user:null}（200）', async () => {
    await registerAndGetCookie('小明')
    const login = await handler.fetch(post('/api/auth/login', { nickname: '小明', password: 'password-123' }), env, ctx)
    expect(login.status).toBe(200)
    const cookie = cookieOf(login)

    const meRes = await handler.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `mp_session=${cookie}` } }), env, ctx)
    expect(((await meRes.json()) as { user: { nickname: string } | null }).user?.nickname).toBe('小明')

    const anon = await handler.fetch(new Request(`${ORIGIN}/api/auth/me`), env, ctx)
    expect(anon.status).toBe(200)
    expect(((await anon.json()) as { user: unknown }).user).toBeNull()
  })

  it('登录失败：错密码/不存在用户统一 401 同信封；连续 5 次后 429 锁定', async () => {
    await registerAndGetCookie('小明')
    const wrong = await handler.fetch(post('/api/auth/login', { nickname: '小明', password: 'wrong-pass-1' }), env, ctx)
    expect(wrong.status).toBe(401)
    const ghost = await handler.fetch(post('/api/auth/login', { nickname: '路人甲', password: 'wrong-pass-1' }), env, ctx)
    expect(ghost.status).toBe(401)
    expect(await wrong.json()).toEqual(await ghost.clone().json())

    for (let i = 0; i < 4; i++) {
      await handler.fetch(post('/api/auth/login', { nickname: '小明', password: 'wrong-pass-1' }), env, ctx)
    }
    const locked = await handler.fetch(post('/api/auth/login', { nickname: '小明', password: 'password-123' }), env, ctx)
    expect(locked.status).toBe(429)
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe('rate_limited')
  })

  it('CSRF：伪造 Origin 的写请求 403（登录与登出同样拦截）', async () => {
    const evil = await handler.fetch(post('/api/auth/login', { nickname: '小明', password: 'password-123' }, { origin: 'http://evil.example' }), env, ctx)
    expect(evil.status).toBe(403)
    const cookie = await registerAndGetCookie()
    const evilLogout = await handler.fetch(post('/api/auth/logout', {}, { cookie, origin: 'http://evil.example' }), env, ctx)
    expect(evilLogout.status).toBe(403)
  })

  it('登出：清除 Cookie + 删除会话行；旧 cookie 再访问 me 为空', async () => {
    const cookie = await registerAndGetCookie('小明')
    const logout = await handler.fetch(post('/api/auth/logout', {}, { cookie }), env, ctx)
    expect(logout.status).toBe(200)
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0')
    expect(db.sessions).toHaveLength(0)
    const meRes = await handler.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `mp_session=${cookie}` } }), env, ctx)
    expect(((await meRes.json()) as { user: unknown }).user).toBeNull()
  })

  it('改昵称：生效 + 占用 409；未登录 401', async () => {
    const cookie = await registerAndGetCookie('小明')
    const anon = await handler.fetch(patch('/api/auth/nickname', { nickname: '无名氏' }, 'bogus'), env, ctx)
    expect(anon.status).toBe(401)

    const res = await handler.fetch(patch('/api/auth/nickname', { nickname: '小明二号' }, cookie), env, ctx)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { user: { nickname: string } }).user.nickname).toBe('小明二号')

    await registerAndGetCookie('别人')
    const taken = await handler.fetch(patch('/api/auth/nickname', { nickname: '别人' }, cookie), env, ctx)
    expect(taken.status).toBe(409)
  })

  it('改密码：旧密码错 401；成功后旧密码失效、当前会话保留、其余会话吊销', async () => {
    const cookie = await registerAndGetCookie('小明')
    const otherLogin = await handler.fetch(post('/api/auth/login', { nickname: '小明', password: 'password-123' }), env, ctx)
    const otherCookie = cookieOf(otherLogin)
    expect(db.sessions).toHaveLength(2)

    const wrongOld = await handler.fetch(post('/api/auth/password', { oldPassword: 'bad-old-pass', newPassword: 'new-password-9' }, { cookie }), env, ctx)
    expect(wrongOld.status).toBe(401)

    const ok = await handler.fetch(post('/api/auth/password', { oldPassword: 'password-123', newPassword: 'new-password-9' }, { cookie }), env, ctx)
    expect(ok.status).toBe(200)
    expect(db.sessions).toHaveLength(1)

    const reloginOld = await handler.fetch(post('/api/auth/login', { nickname: '小明', password: 'password-123' }), env, ctx)
    expect(reloginOld.status).toBe(401)
    const reloginNew = await handler.fetch(post('/api/auth/login', { nickname: '小明', password: 'new-password-9' }), env, ctx)
    expect(reloginNew.status).toBe(200)

    const revokedMe = await handler.fetch(new Request(`${ORIGIN}/api/auth/me`, { headers: { Cookie: `mp_session=${otherCookie}` } }), env, ctx)
    expect(((await revokedMe.json()) as { user: unknown }).user).toBeNull()
  })
})
