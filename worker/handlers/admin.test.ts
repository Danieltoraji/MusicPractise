import { beforeEach, describe, expect, it } from 'vitest'
import handler from '../index'
import { D1Fake } from '../testhelpers/d1fake'
import type { Env, ExecutionContext } from '../types'
import goodLevel from '../../src/sample/tutorial-hello.level.json'

/**
 * 管理后台 API 集成测试（docs/31 §5.4，批次 B4）：核心是权限矩阵（未登录 401 /
 * 普通用户 403 / admin 通过）、防自锁、禁用即下线、重置密码、级联删除与审计落库。
 * admin 产生方式：注册后直接改 fake 表 role 字段（种子脚本路径由 wrangler dev 实测覆盖）。
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

function request(method: string, path: string, body?: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: ORIGIN }
  if (cookie) headers.Cookie = `mp_session=${cookie}`
  return new Request(`${ORIGIN}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers })
}

function cookieOf(res: Response): string {
  const match = /mp_session=([^;]*)/.exec(res.headers.get('Set-Cookie') ?? '')
  expect(match).toBeTruthy()
  return match![1]
}

let env: Env
let db: D1Fake

beforeEach(() => {
  const made = makeEnv()
  env = made.env
  db = made.db
})

/** 注册并按需提升为 admin，返回会话 cookie 与用户 id */
async function makeUser(nickname: string, role: 'user' | 'admin' = 'user'): Promise<{ cookie: string; id: string }> {
  const res = await handler.fetch(request('POST', '/api/auth/register', { nickname, password: 'password-123' }), env, ctx)
  expect(res.status).toBe(201)
  const cookie = cookieOf(res)
  const id = String(db.users[db.users.length - 1].id)
  if (role === 'admin') {
    const row = db.users.find((r) => r.id === id)!
    row.role = 'admin'
  }
  return { cookie, id }
}

describe('管理后台 API（fetch handler 集成，docs/31 §5.4）', () => {
  it('权限矩阵：未登录 401；普通用户全端点 403 forbidden；admin 全部通过', async () => {
    const user = await makeUser('普通用户')
    const admin = await makeUser('站长', 'admin')
    const paths: [string, string, unknown?][] = [
      ['GET', '/api/admin/stats'],
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/levels'],
      ['GET', '/api/admin/audit'],
      ['PATCH', '/api/admin/users/usr_X', { status: 'disabled' }],
      ['DELETE', '/api/admin/users/usr_X'],
      ['DELETE', '/api/admin/levels/cld_X'],
    ]
    for (const [method, path, body] of paths) {
      const anon = await handler.fetch(request(method, path, body), env, ctx)
      expect(anon.status, `未登录 ${method} ${path}`).toBe(401)
      const plain = await handler.fetch(request(method, path, body, user.cookie), env, ctx)
      expect(plain.status, `普通用户 ${method} ${path}`).toBe(403)
      expect(((await plain.json()) as { error: { code: string } }).error.code).toBe('forbidden')
    }
    const ok = await handler.fetch(request('GET', '/api/admin/stats', undefined, admin.cookie), env, ctx)
    expect(ok.status).toBe(200)
  })

  it('stats：用户/云盘/活跃会话计数', async () => {
    const { cookie: userCookie } = await makeUser('用户甲')
    const admin = await makeUser('站长', 'admin')
    await handler.fetch(
      request('POST', '/api/cloud/levels', { levelId: (goodLevel as { id: string }).id, title: 't', payload: goodLevel }, userCookie),
      env,
      ctx,
    )
    const stats = await handler.fetch(request('GET', '/api/admin/stats', undefined, admin.cookie), env, ctx)
    expect(await stats.json()).toEqual({ users: 2, cloudLevels: 1, activeSessions: 2 })
  })

  it('用户列表：LIKE 搜索昵称 + total', async () => {
    await makeUser('张小明明')
    await makeUser('李雷')
    const admin = await makeUser('站长', 'admin')
    const all = await handler.fetch(request('GET', '/api/admin/users', undefined, admin.cookie), env, ctx)
    expect(((await all.json()) as { total: number }).total).toBe(3)
    const hit = await handler.fetch(request('GET', '/api/admin/users?query=%E5%B0%8F%E6%98%8E', undefined, admin.cookie), env, ctx)
    const hitBody = (await hit.json()) as { users: { nickname: string }[]; total: number }
    expect(hitBody.total).toBe(1)
    expect(hitBody.users[0].nickname).toBe('张小明明')
  })

  it('PATCH 禁用：目标会话被吊销（强制下线）+ 登录被拒 + 审计落库', async () => {
    const target = await makeUser('用户甲')
    const admin = await makeUser('站长', 'admin')
    const patch = await handler.fetch(request('PATCH', `/api/admin/users/${target.id}`, { status: 'disabled' }, admin.cookie), env, ctx)
    expect(patch.status).toBe(200)
    expect(((await patch.json()) as { user: { status: string } }).user.status).toBe('disabled')
    // 目标原会话失效
    const me = await handler.fetch(request('GET', '/api/auth/me', undefined, target.cookie), env, ctx)
    expect(((await me.json()) as { user: unknown }).user).toBeNull()
    // 重新登录被拒（账号停用）
    const login = await handler.fetch(request('POST', '/api/auth/login', { nickname: '用户甲', password: 'password-123' }), env, ctx)
    expect(login.status).toBe(403)
    // 审计
    expect(db.audit_log).toHaveLength(1)
    expect(db.audit_log[0]).toMatchObject({ action: 'admin.patch_user', target_id: target.id })
    expect(String(db.audit_log[0].detail)).toContain('"status":"disabled"')
    const audit = await handler.fetch(request('GET', '/api/admin/audit', undefined, admin.cookie), env, ctx)
    const auditBody = (await audit.json()) as { entries: { action: string; actorNickname: string }[] }
    expect(auditBody.entries[0].action).toBe('admin.patch_user')
    expect(auditBody.entries[0].actorNickname).toBe('站长')
  })

  it('PATCH 重置密码：旧密码失效、新密码可用、目标全部会话吊销', async () => {
    const target = await makeUser('用户甲')
    const admin = await makeUser('站长', 'admin')
    const patch = await handler.fetch(request('PATCH', `/api/admin/users/${target.id}`, { newPassword: 'new-pass-456789' }, admin.cookie), env, ctx)
    expect(patch.status).toBe(200)
    const oldLogin = await handler.fetch(request('POST', '/api/auth/login', { nickname: '用户甲', password: 'password-123' }), env, ctx)
    expect(oldLogin.status).toBe(401)
    const newLogin = await handler.fetch(request('POST', '/api/auth/login', { nickname: '用户甲', password: 'new-pass-456789' }), env, ctx)
    expect(newLogin.status).toBe(200)
    const me = await handler.fetch(request('GET', '/api/auth/me', undefined, target.cookie), env, ctx)
    expect(((await me.json()) as { user: unknown }).user).toBeNull()
  })

  it('PATCH 提升角色：目标随即具备 admin 权限', async () => {
    const target = await makeUser('用户甲')
    const admin = await makeUser('站长', 'admin')
    const patch = await handler.fetch(request('PATCH', `/api/admin/users/${target.id}`, { role: 'admin' }, admin.cookie), env, ctx)
    expect(patch.status).toBe(200)
    const stats = await handler.fetch(request('GET', '/api/admin/stats', undefined, target.cookie), env, ctx)
    expect(stats.status).toBe(200)
  })

  it('防自锁：PATCH 自己 / DELETE 自己 → 400', async () => {
    const admin = await makeUser('站长', 'admin')
    const selfPatch = await handler.fetch(request('PATCH', `/api/admin/users/${admin.id}`, { status: 'disabled' }, admin.cookie), env, ctx)
    expect(selfPatch.status).toBe(400)
    expect(((await selfPatch.json()) as { error: { code: string } }).error.code).toBe('cannot_modify_self')
    const selfDelete = await handler.fetch(request('DELETE', `/api/admin/users/${admin.id}`, undefined, admin.cookie), env, ctx)
    expect(selfDelete.status).toBe(400)
    expect(((await selfDelete.json()) as { error: { code: string } }).error.code).toBe('cannot_delete_self')
    const noField = await handler.fetch(request('PATCH', `/api/admin/users/${admin.id}`, {}, admin.cookie), env, ctx)
    expect(noField.status).toBe(400)
  })

  it('DELETE 用户：级联清理会话/云盘/进度 + 用户消失 + 审计', async () => {
    const target = await makeUser('用户甲')
    const admin = await makeUser('站长', 'admin')
    // 造三类属主数据
    await handler.fetch(
      request('POST', '/api/cloud/levels', { levelId: (goodLevel as { id: string }).id, title: '甲的关卡', payload: goodLevel }, target.cookie),
      env,
      ctx,
    )
    await handler.fetch(
      request('PUT', '/api/progress', { records: [{ levelId: (goodLevel as { id: string }).id, bestScore: 50, passed: 1, attempts: 2, updatedAt: 1 }] }, target.cookie),
      env,
      ctx,
    )
    expect(db.sessions.filter((s) => s.user_id === target.id)).toHaveLength(1)

    const del = await handler.fetch(request('DELETE', `/api/admin/users/${target.id}`, undefined, admin.cookie), env, ctx)
    expect(del.status).toBe(200)
    expect(db.users.find((r) => r.id === target.id)).toBeUndefined()
    expect(db.sessions.filter((s) => s.user_id === target.id)).toHaveLength(0)
    expect(db.cloud_levels.filter((r) => r.user_id === target.id)).toHaveLength(0)
    expect(db.progress.filter((r) => r.user_id === target.id)).toHaveLength(0)
    const login = await handler.fetch(request('POST', '/api/auth/login', { nickname: '用户甲', password: 'password-123' }), env, ctx)
    expect(login.status).toBe(401)
    expect(db.audit_log.at(-1)).toMatchObject({ action: 'admin.delete_user', target_id: target.id })
  })

  it('关卡管理：列表含属主昵称 + 搜索 + admin 删除他人槽位（写审计）', async () => {
    const user = await makeUser('用户甲')
    const admin = await makeUser('站长', 'admin')
    const up = await handler.fetch(
      request('POST', '/api/cloud/levels', { levelId: (goodLevel as { id: string }).id, title: '甲的关卡', payload: goodLevel }, user.cookie),
      env,
      ctx,
    )
    const slotId = ((await up.json()) as { level: { id: string } }).level.id

    const hit = await handler.fetch(request('GET', '/api/admin/levels?query=%E7%94%B2%E7%9A%84', undefined, admin.cookie), env, ctx)
    const hitBody = (await hit.json()) as { levels: { ownerNickname: string; title: string }[]; total: number }
    expect(hitBody.total).toBe(1)
    expect(hitBody.levels[0].ownerNickname).toBe('用户甲')

    const miss = await handler.fetch(request('GET', '/api/admin/levels?query=nomatch', undefined, admin.cookie), env, ctx)
    expect(((await miss.json()) as { total: number }).total).toBe(0)

    const del = await handler.fetch(request('DELETE', `/api/admin/levels/${slotId}`, undefined, admin.cookie), env, ctx)
    expect(del.status).toBe(200)
    expect(db.cloud_levels).toHaveLength(0)
    expect(db.audit_log.at(-1)).toMatchObject({ action: 'admin.delete_level', target_id: slotId })
  })

  it('审计列表：倒序 + 分页 limit/offset', async () => {
    const admin = await makeUser('站长', 'admin')
    const target = await makeUser('用户甲')
    for (let i = 0; i < 3; i++) {
      await handler.fetch(request('PATCH', `/api/admin/users/${target.id}`, { status: i % 2 === 0 ? 'disabled' : 'active' }, admin.cookie), env, ctx)
    }
    const page1 = await handler.fetch(request('GET', '/api/admin/audit?limit=2&offset=0', undefined, admin.cookie), env, ctx)
    const p1 = (await page1.json()) as { entries: unknown[]; total: number }
    expect(p1.total).toBe(3)
    expect(p1.entries).toHaveLength(2)
    const page2 = await handler.fetch(request('GET', '/api/admin/audit?limit=2&offset=2', undefined, admin.cookie), env, ctx)
    const p2 = (await page2.json()) as { entries: unknown[] }
    expect(p2.entries).toHaveLength(1)
  })
})
