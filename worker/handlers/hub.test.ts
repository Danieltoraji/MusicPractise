import { beforeEach, describe, expect, it } from 'vitest'
import handler from '../index'
import { D1Fake } from '../testhelpers/d1fake'
import type { Env, ExecutionContext } from '../types'
import goodLevel from '../../src/sample/tutorial-hello.level.json'

/**
 * 关卡库 API 集成测试（docs/39 §5.2，批次 H3）：申请公开 → 审核 → 公开 → 下载全闭环。
 * 覆盖：快照制、同内容唯一（409）、更新发布、待审 ≤5、源槽位锁定（409 publish_locked）、
 * 撤回解锁、驳回与重新申请、管理队列权限矩阵、审计、匿名列表/详情与下载计数、精选参数、限流。
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

async function uploadLevelSlot(cookie: string, id: number, title = `关卡${id}`): Promise<string> {
  const res = await handler.fetch(request('POST', '/api/cloud/levels', { levelId: resId(id), title, payload: { ...(goodLevel as Record<string, unknown>), id: resId(id) } }, cookie), env, ctx)
  expect(res.status).toBe(201)
  return ((await res.json()) as { level: { id: string } }).level.id
}

async function publishLevel(cookie: string, slotId: string, body: Record<string, unknown> = {}): Promise<Response> {
  return handler.fetch(request('POST', `/api/cloud/levels/${slotId}/publish`, body, cookie), env, ctx)
}

describe('关卡库 API（docs/39 §5.2）', () => {
  it('匿名：列表 200 空集；详情/mine 未登录语义正确', async () => {
    const list = await handler.fetch(request('GET', '/api/hub/items'), env, ctx)
    expect(list.status).toBe(200)
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0)
    expect((await handler.fetch(request('GET', '/api/hub/items/hub_X'), env, ctx)).status).toBe(404)
    expect((await handler.fetch(request('GET', '/api/hub/mine'), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('GET', '/api/hub/items?scope=group'), env, ctx)).status).toBe(400)
  })

  it('申请公开正例：快照 pending；未公开前匿名不可见；本人与管理员可看详情', async () => {
    const cookie = await registerUser('小明')
    const slotId = await uploadLevelSlot(cookie, 1, '新手引导')
    const pub = await publishLevel(cookie, slotId, { note: '请审核', wantFeatured: true })
    expect(pub.status).toBe(201)
    const pubBody = (await pub.json()) as { item: { id: string; status: string }; pendingCount: number }
    expect(pubBody.item.status).toBe('pending')
    expect(pubBody.pendingCount).toBe(1)
    expect(db.hub_items).toHaveLength(1)
    expect(db.hub_item_docs).toHaveLength(1)
    expect(db.hub_items[0].submitter_name).toBe('小明')
    expect(db.hub_items[0].want_featured).toBe(1)

    // 匿名列表/详情：pending 不可见
    const anonList = await handler.fetch(request('GET', '/api/hub/items'), env, ctx)
    expect(((await anonList.json()) as { items: unknown[] }).items).toHaveLength(0)
    expect((await handler.fetch(request('GET', `/api/hub/items/${pubBody.item.id}`), env, ctx)).status).toBe(404)
    // 本人可看
    expect((await handler.fetch(request('GET', `/api/hub/items/${pubBody.item.id}`, undefined, cookie), env, ctx)).status).toBe(200)
    // mine 全状态
    const mine = await handler.fetch(request('GET', '/api/hub/mine', undefined, cookie), env, ctx)
    const mineBody = (await mine.json()) as { items: { status: string; submitterNote: string | null }[] }
    expect(mineBody.items).toHaveLength(1)
    expect(mineBody.items[0].status).toBe('pending')
    expect(mineBody.items[0].submitterNote).toBe('请审核')
  })

  it('审核闭环：approve → 匿名可见 + 下载计数 + 审计；非 admin 403', async () => {
    const cookie = await registerUser('小明')
    const adminCookie = await registerAdmin('管理员')
    const slotId = await uploadLevelSlot(cookie, 1)
    const pub = await publishLevel(cookie, slotId)
    const itemId = ((await pub.json()) as { item: { id: string } }).item.id

    const forbidden = await handler.fetch(request('POST', `/api/admin/hub/${itemId}/approve`, {}, cookie), env, ctx)
    expect(forbidden.status).toBe(403)

    const approve = await handler.fetch(request('POST', `/api/admin/hub/${itemId}/approve`, { featured: true }, adminCookie), env, ctx)
    expect(approve.status).toBe(200)
    expect(((await approve.json()) as { featured: boolean }).featured).toBe(true)
    expect(db.hub_items[0].status).toBe('published')
    expect(db.hub_items[0].featured).toBe(1)

    // 匿名列表可见（含 featured 过滤）
    const list = await handler.fetch(request('GET', '/api/hub/items'), env, ctx)
    const listBody = (await list.json()) as { items: { id: string; title: string; authorName: string; featured: boolean; downloads: number }[]; total: number }
    expect(listBody.total).toBe(1)
    expect(listBody.items[0].title).toBe('关卡1')
    expect(listBody.items[0].authorName).toBe('小明')
    expect(listBody.items[0].featured).toBe(true)
    const featList = await handler.fetch(request('GET', '/api/hub/items?featured=1'), env, ctx)
    expect(((await featList.json()) as { total: number }).total).toBe(1)

    // 匿名详情：docs payload + 下载计数
    const detail = await handler.fetch(request('GET', `/api/hub/items/${itemId}`), env, ctx)
    expect(detail.status).toBe(200)
    const detailBody = (await detail.json()) as { docs: { payload: { id: string } }[] }
    expect(detailBody.docs).toHaveLength(1)
    expect(detailBody.docs[0].payload.id).toBe(resId(1))
    expect(db.hub_items[0].downloads).toBe(1)

    // 审计
    expect(db.audit_log.some((a) => a.action === 'hub.approve' && a.target_id === itemId)).toBe(true)
  })

  it('同内容唯一：他人已公开 → 409 already_published；自己重复申请 = 更新发布（重置 pending）', async () => {
    const cookieA = await registerUser('用户甲')
    const cookieB = await registerUser('用户乙')
    const slotA = await uploadLevelSlot(cookieA, 1)
    const pub = await publishLevel(cookieA, slotA)
    const itemId = ((await pub.json()) as { item: { id: string } }).item.id
    const adminCookie = await registerAdmin('管理员')
    await handler.fetch(request('POST', `/api/admin/hub/${itemId}/approve`, {}, adminCookie), env, ctx)

    // 乙上传同一关卡（同 res id）并申请公开 → 409
    await uploadLevelSlot(cookieB, 1)
    const slotB = ((await handler.fetch(request('GET', '/api/cloud/levels', undefined, cookieB), env, ctx)).json() as Promise<{ levels: { id: string }[] }>)
    const slotBId = (await slotB).levels[0].id
    const dup = await publishLevel(cookieB, slotBId)
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('already_published')

    // 甲更新发布：published → pending，匿名列表随之清空
    const again = await publishLevel(cookieA, slotA, { note: '修订版' })
    expect(again.status).toBe(201)
    expect(db.hub_items[0].status).toBe('pending')
    const list = await handler.fetch(request('GET', '/api/hub/items'), env, ctx)
    expect(((await list.json()) as { total: number }).total).toBe(0)
  })

  it('待审上限：第 6 条 pending → 409 too_many_pending', async () => {
    const cookie = await registerUser('小明')
    for (let i = 0; i < 5; i++) {
      const slotId = await uploadLevelSlot(cookie, 10 + i)
      expect((await publishLevel(cookie, slotId)).status).toBe(201)
    }
    const slot6 = await uploadLevelSlot(cookie, 20)
    const sixth = await publishLevel(cookie, slot6)
    expect(sixth.status).toBe(409)
    expect(((await sixth.json()) as { error: { code: string } }).error.code).toBe('too_many_pending')
  })

  it('驳回：附理由 + 审计；重新申请可覆盖 rejected；驳回后源槽位解锁', async () => {
    const cookie = await registerUser('小明')
    const adminCookie = await registerAdmin('管理员')
    const slotId = await uploadLevelSlot(cookie, 1)
    const pub = await publishLevel(cookie, slotId)
    const itemId = ((await pub.json()) as { item: { id: string } }).item.id

    const noReason = await handler.fetch(request('POST', `/api/admin/hub/${itemId}/reject`, {}, adminCookie), env, ctx)
    expect(noReason.status).toBe(400)
    const reject = await handler.fetch(request('POST', `/api/admin/hub/${itemId}/reject`, { reason: '难度标注不符' }, adminCookie), env, ctx)
    expect(reject.status).toBe(200)
    expect(db.hub_items[0].status).toBe('rejected')
    expect(db.hub_items[0].reject_reason).toBe('难度标注不符')
    expect(db.audit_log.some((a) => a.action === 'hub.reject')).toBe(true)

    // rejected 不锁源：可删除
    const del = await handler.fetch(request('DELETE', `/api/cloud/levels/${slotId}`, undefined, cookie), env, ctx)
    expect(del.status).toBe(200)

    // 重新申请（重建同 id 槽位）→ 覆盖 rejected 为 pending
    const slotId2 = await uploadLevelSlot(cookie, 1, '新手引导·修订')
    const again = await publishLevel(cookie, slotId2)
    expect(again.status).toBe(201)
    expect(db.hub_items).toHaveLength(1)
    expect(db.hub_items[0].status).toBe('pending')
    expect(db.hub_items[0].reject_reason).toBeNull()
  })

  it('源槽位锁定：pending/published 期间 DELETE 云盘源 → 409 publish_locked；系列同理', async () => {
    const cookie = await registerUser('小明')
    const slotId = await uploadLevelSlot(cookie, 1)
    expect((await publishLevel(cookie, slotId)).status).toBe(201)
    const locked = await handler.fetch(request('DELETE', `/api/cloud/levels/${slotId}`, undefined, cookie), env, ctx)
    expect(locked.status).toBe(409)
    expect(((await locked.json()) as { error: { code: string } }).error.code).toBe('publish_locked')

    // 系列：上传文件夹 → 申请公开 → 删除文件夹被锁
    const folderId = resId(100)
    const tid = resId(200)
    const lid = resId(300)
    const body = {
      folderId,
      title: '系列',
      docs: [
        { id: folderId, kind: 'series', payload: { schemaVersion: 1, kind: 'series', id: folderId, version: '1.0.0', meta: { title: '系列' }, refs: [], content: { topicIds: [tid] } } },
        { id: lid, kind: 'level', payload: { ...(goodLevel as Record<string, unknown>), id: lid } },
        { id: tid, kind: 'topic', payload: { schemaVersion: 1, kind: 'topic', id: tid, version: '1.0.0', meta: { title: '专题' }, refs: [], content: { levelIds: [lid], brief: '' } } },
      ],
    }
    const up = await handler.fetch(request('POST', '/api/cloud/folders', body, cookie), env, ctx)
    const folderSlotId = ((await up.json()) as { folder: { id: string } }).folder.id
    const pubFolder = await handler.fetch(request('POST', `/api/cloud/folders/${folderSlotId}/publish`, {}, cookie), env, ctx)
    expect(pubFolder.status).toBe(201)
    expect(db.hub_items.filter((r) => r.item_kind === 'series')).toHaveLength(1)
    expect(db.hub_item_docs.filter((d) => d.kind === 'series')).toHaveLength(1)
    const delFolder = await handler.fetch(request('DELETE', `/api/cloud/folders/${folderSlotId}`, undefined, cookie), env, ctx)
    expect(delFolder.status).toBe(409)
    expect(((await delFolder.json()) as { error: { code: string } }).error.code).toBe('publish_locked')
  })

  it('撤回：本人可撤 pending/published，删除即解锁；他人撤 404', async () => {
    const cookieA = await registerUser('用户甲')
    const cookieB = await registerUser('用户乙')
    const slotId = await uploadLevelSlot(cookieA, 1)
    const pub = await publishLevel(cookieA, slotId)
    const { item } = (await pub.json()) as { item: { id: string } }

    expect((await handler.fetch(request('DELETE', `/api/hub/items/${item.id}`, undefined, cookieB), env, ctx)).status).toBe(404)
    const wd = await handler.fetch(request('DELETE', `/api/hub/items/${item.id}`, undefined, cookieA), env, ctx)
    expect(wd.status).toBe(200)
    expect(db.hub_items).toHaveLength(0)
    expect(db.hub_item_docs).toHaveLength(0)
    // 撤回后源槽位可删
    expect((await handler.fetch(request('DELETE', `/api/cloud/levels/${slotId}`, undefined, cookieA), env, ctx)).status).toBe(200)
  })

  it('管理队列：默认 pending、LIKE 过滤、非 pending 不可审、重复批准 409', async () => {
    const cookie = await registerUser('小明')
    const adminCookie = await registerAdmin('管理员')
    const s1 = await uploadLevelSlot(cookie, 1, '音乐理论入门')
    const s2 = await uploadLevelSlot(cookie, 2, '节奏训练')
    await publishLevel(cookie, s1)
    await publishLevel(cookie, s2)

    const queue = await handler.fetch(request('GET', '/api/admin/hub', undefined, adminCookie), env, ctx)
    const queueBody = (await queue.json()) as { items: { title: string; status: string; wantFeatured: boolean }[]; total: number }
    expect(queueBody.total).toBe(2)

    const filtered = await handler.fetch(request('GET', '/api/admin/hub?query=节奏', undefined, adminCookie), env, ctx)
    const filteredBody = (await filtered.json()) as { items: { title: string }[]; total: number }
    expect(filteredBody.total).toBe(1)
    expect(filteredBody.items[0].title).toBe('节奏训练')

    const queueAgain = (await (await handler.fetch(request('GET', '/api/admin/hub', undefined, adminCookie), env, ctx)).json()) as { items: { id: string }[] }
    const itemId = queueAgain.items[0].id
    await handler.fetch(request('POST', `/api/admin/hub/${itemId}/approve`, {}, adminCookie), env, ctx)
    const again = await handler.fetch(request('POST', `/api/admin/hub/${itemId}/approve`, {}, adminCookie), env, ctx)
    expect(again.status).toBe(409)
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('not_pending')
    const afterQueue = await handler.fetch(request('GET', '/api/admin/hub', undefined, adminCookie), env, ctx)
    expect(((await afterQueue.json()) as { total: number }).total).toBe(1)
  })

  it('匿名详情限流：30 次/小时/IP，超限 429', async () => {
    const cookie = await registerUser('小明')
    const adminCookie = await registerAdmin('管理员')
    const slotId = await uploadLevelSlot(cookie, 1)
    const pub = await publishLevel(cookie, slotId)
    const itemId = ((await pub.json()) as { item: { id: string } }).item.id
    await handler.fetch(request('POST', `/api/admin/hub/${itemId}/approve`, {}, adminCookie), env, ctx)

    for (let i = 0; i < 30; i++) {
      const res = await handler.fetch(request('GET', `/api/hub/items/${itemId}`), env, ctx)
      expect(res.status).toBe(200)
    }
    const limited = await handler.fetch(request('GET', `/api/hub/items/${itemId}`), env, ctx)
    expect(limited.status).toBe(429)
    expect(db.hub_items[0].downloads).toBe(30)
  })

  it('发布限流：10 次/小时/用户，超限 429（撤回不计入）', async () => {
    const cookie = await registerUser('小明')
    const slotIds: string[] = []
    for (let i = 0; i < 6; i++) slotIds.push(await uploadLevelSlot(cookie, 40 + i))
    // 前 5 次申请占满待审上限（计数 1-5）
    for (let i = 0; i < 5; i++) {
      expect((await publishLevel(cookie, slotIds[i])).status).toBe(201)
    }
    // 第 6 次撞待审上限（计数 6）
    expect((await publishLevel(cookie, slotIds[5])).status).toBe(409)
    // 「撤回一条旧 pending → 发布 slot6」：发布每次都计数（7/8/9/10 放行，11 → 429）
    const withdrawOneOldPending = async (): Promise<void> => {
      const mine = (await (await handler.fetch(request('GET', '/api/hub/mine', undefined, cookie), env, ctx)).json()) as { items: { id: string; status: string; rootDocId: string }[] }
      const target = mine.items.find((it) => it.status === 'pending' && it.rootDocId !== resId(45))!
      expect(target, '应还有旧 pending 可撤').toBeTruthy()
      await handler.fetch(request('DELETE', `/api/hub/items/${target.id}`, undefined, cookie), env, ctx)
    }
    await withdrawOneOldPending()
    expect((await publishLevel(cookie, slotIds[5])).status).toBe(201)
    for (let i = 0; i < 3; i++) {
      await withdrawOneOldPending()
      expect((await publishLevel(cookie, slotIds[5])).status, `第 ${i} 轮更新发布应在限流内放行`).toBe(201)
    }
    const eleventh = await publishLevel(cookie, slotIds[5])
    expect(eleventh.status).toBe(429)
    expect(((await eleventh.json()) as { error: { code: string } }).error.code).toBe('rate_limited')
  })
})

describe('精选开关与官方库（docs/39 H4）', () => {
  async function publishAndApprove(cookie: string, slotId: string, adminCookie: string, featured = false): Promise<string> {
    const pub = await publishLevel(cookie, slotId)
    const itemId = ((await pub.json()) as { item: { id: string } }).item.id
    const res = await handler.fetch(request('POST', `/api/admin/hub/${itemId}/approve`, { featured }, adminCookie), env, ctx)
    expect(res.status).toBe(200)
    return itemId
  }

  it('精选开关：PATCH 随时指定/取消（仅 published）；写审计；非 admin 403', async () => {
    const cookie = await registerUser('小明')
    const adminCookie = await registerAdmin('管理员')
    const slotId = await uploadLevelSlot(cookie, 1)
    const itemId = await publishAndApprove(cookie, slotId, adminCookie)

    const nonAdmin = await handler.fetch(request('PATCH', `/api/admin/hub/${itemId}`, { featured: true }, cookie), env, ctx)
    expect(nonAdmin.status).toBe(403)

    const bad = await handler.fetch(request('PATCH', `/api/admin/hub/${itemId}`, { featured: 'yes' }, adminCookie), env, ctx)
    expect(bad.status).toBe(400)

    const on = await handler.fetch(request('PATCH', `/api/admin/hub/${itemId}`, { featured: true }, adminCookie), env, ctx)
    expect(on.status).toBe(200)
    expect(db.hub_items[0].featured).toBe(1)
    const featList = await handler.fetch(request('GET', '/api/hub/items?featured=1'), env, ctx)
    expect(((await featList.json()) as { total: number }).total).toBe(1)
    expect(db.audit_log.some((a) => a.action === 'hub.set_featured' && a.target_id === itemId)).toBe(true)

    const off = await handler.fetch(request('PATCH', `/api/admin/hub/${itemId}`, { featured: false }, adminCookie), env, ctx)
    expect(off.status).toBe(200)
    expect(db.hub_items[0].featured).toBe(0)
  })

  it('admin 移除条目：快照删除 + 审计 + 源槽位解锁', async () => {
    const cookie = await registerUser('小明')
    const adminCookie = await registerAdmin('管理员')
    const slotId = await uploadLevelSlot(cookie, 1)
    const itemId = await publishAndApprove(cookie, slotId, adminCookie)

    const del = await handler.fetch(request('DELETE', `/api/admin/hub/${itemId}`, undefined, adminCookie), env, ctx)
    expect(del.status).toBe(200)
    expect(db.hub_items).toHaveLength(0)
    expect(db.hub_item_docs).toHaveLength(0)
    expect(db.audit_log.some((a) => a.action === 'hub.delete' && a.target_id === itemId)).toBe(true)
    // 源槽位随之解锁：可删除
    expect((await handler.fetch(request('DELETE', `/api/cloud/levels/${slotId}`, undefined, cookie), env, ctx)).status).toBe(200)
  })

  it('官方直传·单关：published + 昵称快照官方 + 匿名 official 域可见', async () => {
    const adminCookie = await registerAdmin('管理员')
    const levelId = resId(70)
    const up = await handler.fetch(request('POST', '/api/admin/hub/official', { levelId, title: '官方教学关', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, adminCookie), env, ctx)
    expect(up.status).toBe(201)
    const body = (await up.json()) as { item: { id: string; itemKind: string; status: string } }
    expect(body.item.itemKind).toBe('level')
    expect(body.item.status).toBe('published')
    expect(db.hub_items[0].submitter_id).toBeNull()
    expect(db.hub_items[0].submitter_name).toBe('官方')
    expect(db.audit_log.some((a) => a.action === 'hub.official_add')).toBe(true)

    const list = await handler.fetch(request('GET', '/api/hub/items?scope=official'), env, ctx)
    const listBody = (await list.json()) as { items: { title: string; authorName: string }[]; total: number }
    expect(listBody.total).toBe(1)
    expect(listBody.items[0].title).toBe('官方教学关')
    expect(listBody.items[0].authorName).toBe('官方')

    // 普通 scope 仍只看公共域
    const pub = await handler.fetch(request('GET', '/api/hub/items'), env, ctx)
    expect(((await pub.json()) as { total: number }).total).toBe(0)
  })

  it('官方直传·系列包：闭包校验复用 + 覆盖更新（不重复占位）', async () => {
    const adminCookie = await registerAdmin('管理员')
    const folderId = resId(80)
    const tid = resId(81)
    const lid = resId(82)
    const body = {
      folderId,
      title: '官方入门系列',
      docs: [
        { id: folderId, kind: 'series', payload: { schemaVersion: 1, kind: 'series', id: folderId, version: '1.0.0', meta: { title: '官方入门系列' }, refs: [], content: { topicIds: [tid] } } },
        { id: lid, kind: 'level', payload: { ...(goodLevel as Record<string, unknown>), id: lid } },
        { id: tid, kind: 'topic', payload: { schemaVersion: 1, kind: 'topic', id: tid, version: '1.0.0', meta: { title: '基础' }, refs: [], content: { levelIds: [lid], brief: '' } } },
      ],
    }
    const first = await handler.fetch(request('POST', '/api/admin/hub/official', body, adminCookie), env, ctx)
    expect(first.status).toBe(201)
    expect(db.hub_items[0].item_kind).toBe('series')

    // 覆盖更新（改标题）→ 200，仍 1 条，docs 整体替换
    const revised = JSON.parse(JSON.stringify(body)) as typeof body
    ;(revised.docs[0].payload as { meta: { title: string } }).meta.title = '官方入门系列·修订'
    revised.title = '官方入门系列·修订'
    const second = await handler.fetch(request('POST', '/api/admin/hub/official', revised, adminCookie), env, ctx)
    expect(second.status).toBe(200)
    expect(db.hub_items).toHaveLength(1)
    expect(db.hub_items[0].title).toBe('官方入门系列·修订')
    expect(db.hub_item_docs).toHaveLength(3)

    // 闭包缺件拒绝
    const broken = JSON.parse(JSON.stringify(body)) as typeof body
    ;(broken.docs[2].payload as { content: { levelIds: string[] } }).content.levelIds = [resId(999)]
    const bad = await handler.fetch(request('POST', '/api/admin/hub/official', broken, adminCookie), env, ctx)
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { message: string } }).error.message).toContain('缺件')
  })

  it('官方直传跨域冲突：公共域已存在同内容 → 409 already_in_public；移除后可传', async () => {
    const cookie = await registerUser('小明')
    const adminCookie = await registerAdmin('管理员')
    const slotId = await uploadLevelSlot(cookie, 60)
    const pub = await publishLevel(cookie, slotId)
    const publicItemId = ((await pub.json()) as { item: { id: string } }).item.id
    await handler.fetch(request('POST', `/api/admin/hub/${publicItemId}/approve`, {}, adminCookie), env, ctx)

    const levelId = resId(60)
    const conflict = await handler.fetch(request('POST', '/api/admin/hub/official', { levelId, title: '官方版', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, adminCookie), env, ctx)
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe('already_in_public')

    // 移除公共条目后官方直传成功
    await handler.fetch(request('DELETE', `/api/admin/hub/${publicItemId}`, undefined, adminCookie), env, ctx)
    const ok = await handler.fetch(request('POST', '/api/admin/hub/official', { levelId, title: '官方版', payload: { ...(goodLevel as Record<string, unknown>), id: levelId } }, adminCookie), env, ctx)
    expect(ok.status).toBe(201)
    expect(db.hub_items).toHaveLength(1)
    expect(db.hub_items[0].scope).toBe('official')
  })

  it('官方库上限 200：触顶 409 official_full', async () => {
    const adminCookie = await registerAdmin('管理员')
    for (let i = 0; i < 200; i++) {
      db.hub_items.push({
        group_id: null,
        id: `hub_${String(i).padStart(26, '0')}`,
        scope: 'official',
        item_kind: 'level',
        root_doc_id: resId(500 + i),
        title: `官方${i}`,
        level_count: 1,
        bytes: 100,
        submitter_id: null,
        submitter_name: '官方',
        submitter_note: null,
        want_featured: 0,
        status: 'published',
        featured: 0,
        reject_reason: null,
        reviewed_by: null,
        reviewed_at: null,
        published_at: now(),
        downloads: 0,
        created_at: now(),
        updated_at: now(),
      })
    }
    const up = await handler.fetch(request('POST', '/api/admin/hub/official', { levelId: resId(999), title: '超限', payload: { ...(goodLevel as Record<string, unknown>), id: resId(999) } }, adminCookie), env, ctx)
    expect(up.status).toBe(409)
    expect(((await up.json()) as { error: { code: string } }).error.code).toBe('official_full')
  })
})
