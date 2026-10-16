import { beforeEach, describe, expect, it } from 'vitest'
import handler from '../index'
import { D1Fake } from '../testhelpers/d1fake'
import type { Env, ExecutionContext } from '../types'
import goodLevel from '../../src/sample/tutorial-hello.level.json'

/**
 * 群组关卡库 API 集成测试（docs/39 §5.3，批次 H5）：
 * 建群（暗号唯一/上限）→ lookup/join（密码与限流）→ 成员管理 → 群库上传/额度 → 群审核 →
 * admin 封禁/解封/强制解散。封禁群对外不可见（lookup 404）、成员访问 403 group_banned。
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

async function registerUser(nickname: string): Promise<string> {
  const res = await handler.fetch(request('POST', '/api/auth/register', { nickname, password: 'password-123' }), env, ctx)
  expect(res.status).toBe(201)
  return cookieOf(res)
}

async function registerAdmin(nickname: string): Promise<string> {
  const cookie = await registerUser(nickname)
  const row = db.users.find((u) => u.nickname === nickname)
  if (row) row.role = 'admin'
  return cookie
}

function resId(n: number): string {
  return `res_${String(n).padStart(26, '0')}`
}

function now(): number {
  return Date.now()
}

async function createGroup(cookie: string, name: string, joinCode: string, password?: string): Promise<Response> {
  return handler.fetch(request('POST', '/api/groups', { name, joinCode, password }, cookie), env, ctx)
}

describe('群组关卡库 API（docs/39 §5.3）', () => {
  it('未登录：全部群端点 401', async () => {
    expect((await handler.fetch(request('POST', '/api/groups', { name: 'g', joinCode: 'abcd' }), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('GET', '/api/groups/mine'), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('GET', '/api/groups/lookup?code=abcd'), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('GET', '/api/groups/grp_X'), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('POST', '/api/groups/grp_X/join', {}), env, ctx)).status).toBe(401)
  })

  it('建群正例：201 + grp_ id + owner 角色；mine 可见；暗号重复 409；上限 3 个', async () => {
    const cookie = await registerUser('小明')
    const res = await createGroup(cookie, '练耳小组', 'lianer2026', 'group-pass')
    expect(res.status).toBe(201)
    const body = (await res.json()) as { group: { id: string; myRole: string; joinCode: string; memberCount: number } }
    expect(body.group.id).toMatch(/^grp_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body.group.myRole).toBe('owner')
    expect(body.group.memberCount).toBe(1)

    const mine = await handler.fetch(request('GET', '/api/groups/mine', undefined, cookie), env, ctx)
    const mineBody = (await mine.json()) as { groups: { name: string; role: string; status: string }[] }
    expect(mineBody.groups).toHaveLength(1)
    expect(mineBody.groups[0].name).toBe('练耳小组')
    expect(mineBody.groups[0].status).toBe('active')

    const dup = await createGroup(cookie, '另一组', 'LIANER2026')
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('code_taken')

    await createGroup(cookie, '第三组', 'group3code')
    const third = await createGroup(cookie, '第四组', 'group4code')
    expect(third.status).toBe(201)
    const fourth = await createGroup(cookie, '第五组', 'group5code')
    expect(fourth.status).toBe(409)
    expect(((await fourth.json()) as { error: { code: string } }).error.code).toBe('group_limit')

    const badCode = await createGroup(cookie, 'x', 'ab cd')
    expect(badCode.status).toBe(400)
  })

  it('lookup 与 join：无密码直加；密码错 403 且 5 次后 429；正确密码加入', async () => {
    const owner = await registerUser('群主')
    await createGroup(owner, '私密组', 'secret1', 'pass-1234')
    const joiner = await registerUser('路人')

    const lookup = await handler.fetch(request('GET', '/api/groups/lookup?code=secret1', undefined, joiner), env, ctx)
    const lookupBody = (await lookup.json()) as { group: { hasPassword: boolean; memberCount: number } }
    expect(lookupBody.group.hasPassword).toBe(true)
    expect(lookupBody.group.memberCount).toBe(1)

    const missing = await handler.fetch(request('GET', '/api/groups/lookup?code=nope1234', undefined, joiner), env, ctx)
    expect(missing.status).toBe(404)

    const groupId = ((await handler.fetch(request('GET', '/api/groups/mine', undefined, owner), env, ctx)).json() as Promise<{ groups: { id: string }[] }>)
    const gid = (await groupId).groups[0].id

    for (let i = 0; i < 5; i++) {
      const wrong = await handler.fetch(request('POST', `/api/groups/${gid}/join`, { password: 'wrong-pass' }, joiner), env, ctx)
      expect(wrong.status).toBe(403)
      expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('wrong_password')
    }
    const locked = await handler.fetch(request('POST', `/api/groups/${gid}/join`, { password: 'pass-1234' }, joiner), env, ctx)
    expect(locked.status).toBe(429)

    // 新用户同窗口不受影响（限流按 用户+群组）
    const joiner2 = await registerUser('路人乙')
    const ok = await handler.fetch(request('POST', `/api/groups/${gid}/join`, { password: 'pass-1234' }, joiner2), env, ctx)
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as { role: string }).role).toBe('member')
  })

  it('无密码群：lookup hasPassword false；join 直加；重复加入 409；退群与群主限制', async () => {
    const owner = await registerUser('群主')
    const created = await createGroup(owner, '开放组', 'open1234')
    const gid = ((await created.json()) as { group: { id: string } }).group.id
    const member = await registerUser('成员甲')

    const lookup = await handler.fetch(request('GET', '/api/groups/lookup?code=open1234', undefined, member), env, ctx)
    expect(((await lookup.json()) as { group: { hasPassword: boolean } }).group.hasPassword).toBe(false)
    expect((await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, member), env, ctx)).status).toBe(200)
    expect((await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, member), env, ctx)).status).toBe(409)

    // 成员可见详情与成员列表；非成员 404
    expect((await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, member), env, ctx)).status).toBe(200)
    const outsider = await registerUser('圈外人')
    expect((await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, outsider), env, ctx)).status).toBe(404)

    // 成员退群 ok；群主退群 409
    expect((await handler.fetch(request('POST', `/api/groups/${gid}/leave`, undefined, member), env, ctx)).status).toBe(200)
    expect((await handler.fetch(request('POST', `/api/groups/${gid}/leave`, undefined, owner), env, ctx)).status).toBe(409)
    expect(((await handler.fetch(request('POST', `/api/groups/${gid}/leave`, undefined, owner), env, ctx)).json() as Promise<{ error: { code: string } }>))
    const ownerLeave = await handler.fetch(request('POST', `/api/groups/${gid}/leave`, undefined, owner), env, ctx)
    expect(((await ownerLeave.json()) as { error: { code: string } }).error.code).toBe('owner_cannot_leave')
  })

  it('群设置与成员管理：owner 专属；任命审核员；移除成员', async () => {
    const owner = await registerUser('群主')
    const created = await createGroup(owner, '管理组', 'admin123')
    const gid = ((await created.json()) as { group: { id: string } }).group.id
    const member = await registerUser('成员甲')
    await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, member), env, ctx)

    // 非 owner 403
    expect((await handler.fetch(request('PATCH', `/api/groups/${gid}`, { name: '篡改' }, member), env, ctx)).status).toBe(403)
    // owner 改名 + 设密码
    const patch = await handler.fetch(request('PATCH', `/api/groups/${gid}`, { name: '管理组·改', password: 'new-pass-1' }, owner), env, ctx)
    expect(patch.status).toBe(200)
    // 新密码生效：原成员未退群，新用户加入需密码
    const newcomer = await registerUser('新人')
    const wrongJoin = await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, newcomer), env, ctx)
    expect(wrongJoin.status).toBe(403)

    // 任命审核员（取成员列表里的 userId）
    const detail = (await (await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, member), env, ctx)).json()) as { members: { userId: string; role: string }[] }
    const memberId = detail.members.find((m) => m.role === 'member')!.userId
    const setRole = await handler.fetch(request('PATCH', `/api/groups/${gid}/members/${memberId}`, { role: 'reviewer' }, owner), env, ctx)
    expect(setRole.status).toBe(200)
    const after = (await (await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, owner), env, ctx)).json()) as { members: { userId: string; role: string }[] }
    expect(after.members.find((m) => m.userId === memberId)!.role).toBe('reviewer')

    // 不能动群主
    const ownerDetail = (await (await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, owner), env, ctx)).json()) as { group: { ownerId: string } }
    const touchOwner = await handler.fetch(request('DELETE', `/api/groups/${gid}/members/${ownerDetail.group.ownerId}`, undefined, owner), env, ctx)
    expect(touchOwner.status).toBe(400)

    // 移除成员（先降回 member 无所谓——移除不看角色）
    const remove = await handler.fetch(request('DELETE', `/api/groups/${gid}/members/${memberId}`, undefined, owner), env, ctx)
    expect(remove.status).toBe(200)
    expect((await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, member), env, ctx)).status).toBe(404)
  })

  it('群库：成员上传单关/系列 → pending；额度上限；同 root 覆盖；审核后 published', async () => {
    const owner = await registerUser('群主')
    const created = await createGroup(owner, '上传组', 'upload1')
    const gid = ((await created.json()) as { group: { id: string } }).group.id
    const member = await registerUser('成员甲')
    await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, member), env, ctx)

    // 单关上传
    const levelId = resId(300)
    const up1 = await handler.fetch(request('POST', `/api/groups/${gid}/items`, { levelId, title: '练习关', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, member), env, ctx)
    expect(up1.status).toBe(201)
    expect(((await up1.json()) as { item: { status: string } }).item.status).toBe('pending')

    // 普通成员只见自己的 pending；审核员见全部
    const memberList = (await (await handler.fetch(request('GET', `/api/groups/${gid}/items`, undefined, member), env, ctx)).json()) as { items: unknown[]; myRole: string }
    expect(memberList.items).toHaveLength(1)
    const ownerList = (await (await handler.fetch(request('GET', `/api/groups/${gid}/items`, undefined, owner), env, ctx)).json()) as { items: unknown[]; myRole: string }
    expect(ownerList.myRole).toBe('owner')
    expect(ownerList.items).toHaveLength(1)

    // 同 root 重复上传 → 覆盖（仍 1 条，重置 pending）
    const again = await handler.fetch(request('POST', `/api/groups/${gid}/items`, { levelId, title: '练习关·改', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, member), env, ctx)
    expect(again.status).toBe(200)
    expect(db.hub_items).toHaveLength(1)
    expect(db.hub_items[0].title).toBe('练习关·改')

    // 系列包上传（2 关）→ level_count 2
    const folderId = resId(400)
    const tid = resId(401)
    const lid1 = resId(402)
    const lid2 = resId(403)
    const bundle = {
      folderId,
      title: '群系列',
      docs: [
        { id: folderId, kind: 'series', payload: { schemaVersion: 1, kind: 'series', id: folderId, version: '1.0.0', meta: { title: '群系列' }, refs: [], content: { topicIds: [tid] } } },
        { id: lid1, kind: 'level', payload: { ...(goodLevel as Record<string, unknown>), id: lid1 } },
        { id: lid2, kind: 'level', payload: { ...(goodLevel as Record<string, unknown>), id: lid2 } },
        { id: tid, kind: 'topic', payload: { schemaVersion: 1, kind: 'topic', id: tid, version: '1.0.0', meta: { title: '专题' }, refs: [], content: { levelIds: [lid1, lid2], brief: '' } } },
      ],
    }
    const up2 = await handler.fetch(request('POST', `/api/groups/${gid}/items`, bundle, member), env, ctx)
    expect(up2.status).toBe(201)
    expect(((await up2.json()) as { groupLevels: number }).groupLevels).toBe(3)

    // 群库额度：seed 到 99 关 → 再传 2 关系列（会到 101）→ 409 group_full
    for (let i = 0; i < 99 - 1; i++) {
      db.hub_items.push({
        group_id: gid,
        id: `hub_${String(i).padStart(26, '0')}`,
        scope: 'group',
        item_kind: 'level',
        root_doc_id: resId(1000 + i),
        title: `bulk${i}`,
        level_count: 1,
        bytes: 100,
        submitter_id: 'usr_other',
        submitter_name: '别人',
        submitter_note: null,
        want_featured: 0,
        status: 'published',
        featured: 0,
        reject_reason: null,
        reviewed_by: null,
        reviewed_at: null,
        published_at: null,
        downloads: 0,
        created_at: now(),
        updated_at: now(),
      })
    }
    const full = await handler.fetch(request('POST', `/api/groups/${gid}/items`, bundle, member), env, ctx)
    expect(full.status).toBe(409)
    expect(((await full.json()) as { error: { code: string } }).error.code).toBe('group_full')
  })

  it('群审核：reviewer 批准/驳回；非审核员 403；非 pending 409', async () => {
    const owner = await registerUser('群主')
    const created = await createGroup(owner, '审核组', 'review1')
    const gid = ((await created.json()) as { group: { id: string } }).group.id
    const member = await registerUser('成员甲')
    await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, member), env, ctx)
    const levelId = resId(300)
    await handler.fetch(request('POST', `/api/groups/${gid}/items`, { levelId, title: '待审关', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, member), env, ctx)
    const itemId = db.hub_items[0].id

    // 普通 member 不可审
    const outsider = await registerUser('圈外人')
    expect((await handler.fetch(request('POST', `/api/groups/${gid}/items/${itemId}/approve`, {}, outsider), env, ctx)).status).toBe(403)

    // 群主任命 member 为审核员后再审
    const detail = (await (await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, member), env, ctx)).json()) as { members: { userId: string; role: string }[] }
    const memberId = detail.members.find((m) => m.role === 'member')!.userId
    await handler.fetch(request('PATCH', `/api/groups/${gid}/members/${memberId}`, { role: 'reviewer' }, owner), env, ctx)
    const approve = await handler.fetch(request('POST', `/api/groups/${gid}/items/${itemId}/approve`, {}, member), env, ctx)
    expect(approve.status).toBe(200)
    expect(db.hub_items[0].status).toBe('published')

    // 重复批准 409；驳回也走同权限
    expect((await handler.fetch(request('POST', `/api/groups/${gid}/items/${itemId}/approve`, {}, member), env, ctx)).status).toBe(409)
  })

  it('群主可移除群库条目（withdraw 扩展）；驳回理由展示', async () => {
    const owner = await registerUser('群主')
    const created = await createGroup(owner, '移除组', 'remove1')
    const gid = ((await created.json()) as { group: { id: string } }).group.id
    const member = await registerUser('成员甲')
    await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, member), env, ctx)
    const levelId = resId(300)
    await handler.fetch(request('POST', `/api/groups/${gid}/items`, { levelId, title: '待删关', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, member), env, ctx)
    const itemId = db.hub_items[0].id

    // 群主移除成员上传（非本人 withdraw 扩展）
    const del = await handler.fetch(request('DELETE', `/api/hub/items/${itemId}`, undefined, owner), env, ctx)
    expect(del.status).toBe(200)
    expect(db.hub_items).toHaveLength(0)

    // 再传一条 → 驳回带理由
    await handler.fetch(request('POST', `/api/groups/${gid}/items`, { levelId, title: '再传', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, member), env, ctx)
    const reject = await handler.fetch(request('POST', `/api/groups/${gid}/items/${db.hub_items[0].id}/reject`, { reason: '与群主题不符' }, owner), env, ctx)
    expect(reject.status).toBe(200)
    expect(db.hub_items[0].status).toBe('rejected')
    expect(db.hub_items[0].reject_reason).toBe('与群主题不符')
  })

  it('admin 群管理：列表/封禁（对外 404、成员 403）/解封/强制解散（级联+审计）', async () => {
    const owner = await registerUser('群主')
    const created = await createGroup(owner, '被封的组', 'banned123')
    const gid = ((await created.json()) as { group: { id: string } }).group.id
    const member = await registerUser('成员甲')
    await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, member), env, ctx)
    const levelId = resId(300)
    await handler.fetch(request('POST', `/api/groups/${gid}/items`, { levelId, title: '群内关', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, member), env, ctx)
    const adminCookie = await registerAdmin('管理员')

    // 列表
    const list = await handler.fetch(request('GET', '/api/admin/groups?query=被封', undefined, adminCookie), env, ctx)
    const listBody = (await list.json()) as { groups: { name: string; ownerNickname: string; memberCount: number; itemCount: number }[]; total: number }
    expect(listBody.total).toBe(1)
    expect(listBody.groups[0].ownerNickname).toBe('群主')
    expect(listBody.groups[0].memberCount).toBe(2)
    expect(listBody.groups[0].itemCount).toBe(1)

    // 封禁
    const ban = await handler.fetch(request('PATCH', `/api/admin/groups/${gid}`, { status: 'banned' }, adminCookie), env, ctx)
    expect(ban.status).toBe(200)
    expect(db.audit_log.some((a) => a.action === 'group.ban')).toBe(true)
    // 对外 lookup 404；成员访问 403 group_banned；join 404
    expect((await handler.fetch(request('GET', '/api/groups/lookup?code=banned123', undefined, member), env, ctx)).status).toBe(404)
    const bannedDetail = await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, member), env, ctx)
    expect(bannedDetail.status).toBe(403)
    expect(((await bannedDetail.json()) as { error: { code: string } }).error.code).toBe('group_banned')
    const newcomer = await registerUser('新人')
    expect((await handler.fetch(request('POST', `/api/groups/${gid}/join`, {}, newcomer), env, ctx)).status).toBe(404)

    // 解封恢复
    await handler.fetch(request('PATCH', `/api/admin/groups/${gid}`, { status: 'active' }, adminCookie), env, ctx)
    expect((await handler.fetch(request('GET', `/api/groups/${gid}`, undefined, member), env, ctx)).status).toBe(200)
    expect(db.audit_log.some((a) => a.action === 'group.unban')).toBe(true)

    // 强制解散：群 + 群库条目级联清除 + 审计
    const disband = await handler.fetch(request('DELETE', `/api/admin/groups/${gid}`, undefined, adminCookie), env, ctx)
    expect(disband.status).toBe(200)
    expect(db.groups).toHaveLength(0)
    expect(db.group_members).toHaveLength(0)
    expect(db.hub_items.filter((r) => r.scope === 'group')).toHaveLength(0)
    expect(db.audit_log.some((a) => a.action === 'group.disband')).toBe(true)
    // 群主的建群额度随解散释放
    const mine = (await (await handler.fetch(request('GET', '/api/groups/mine', undefined, owner), env, ctx)).json()) as { groups: unknown[] }
    expect(mine.groups).toHaveLength(0)
  })
})
