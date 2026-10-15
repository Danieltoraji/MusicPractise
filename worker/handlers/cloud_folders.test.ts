import { beforeEach, describe, expect, it } from 'vitest'
import handler from '../index'
import { D1Fake } from '../testhelpers/d1fake'
import type { Env, ExecutionContext } from '../types'
import goodLevel from '../../src/sample/tutorial-hello.level.json'

/**
 * 云盘文件夹 API 集成测试（docs/39 §5.1，批次 H2）：走完整 fetch handler。
 * 覆盖：闭包校验、恰一系列、逐文档三道闸、合并槽位口径与上限、按 folderId 覆盖、
 * 跨用户隔离、下载回读、删除释放。云盘写限流复用 hitCloudWriteLimit（levels 侧已覆盖）。
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

function request(method: string, path: string, body?: unknown, cookie?: string, origin = ORIGIN): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Origin: origin }
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

function resId(n: number): string {
  return `res_${String(n).padStart(26, '0')}`
}

function seriesDoc(id: string, title: string, topicIds: string[]): Record<string, unknown> {
  return { schemaVersion: 1, kind: 'series', id, version: '1.0.0', meta: { title }, refs: [], content: { topicIds } }
}

function topicDoc(id: string, title: string, levelIds: string[]): Record<string, unknown> {
  return { schemaVersion: 1, kind: 'topic', id, version: '1.0.0', meta: { title }, refs: [], content: { levelIds, brief: '' } }
}

/** 构造合法文件夹包：1 系列 + topicCount 专题 × levelsPerTopic 关卡（条目为 {id, kind, payload} 契约形态） */
function folderBody(folderId: string, title: string, topicCount = 1, levelsPerTopic = 1): Record<string, unknown> {
  const topicIds: string[] = []
  const docs: Record<string, unknown>[] = []
  let n = 0
  for (let t = 0; t < topicCount; t++) {
    const tid = resId(100 + t)
    topicIds.push(tid)
    const levelIds: string[] = []
    for (let l = 0; l < levelsPerTopic; l++) {
      const lid = resId(1000 + n)
      n++
      levelIds.push(lid)
      docs.push({ id: lid, kind: 'level', payload: { ...(goodLevel as Record<string, unknown>), id: lid } })
    }
    docs.push({ id: tid, kind: 'topic', payload: topicDoc(tid, `专题${t}`, levelIds) })
  }
  docs.unshift({ id: folderId, kind: 'series', payload: seriesDoc(folderId, title, topicIds) })
  return { folderId, title, docs }
}

function docEntries(body: Record<string, unknown>): Record<string, unknown>[] {
  return body.docs as Record<string, unknown>[]
}

async function uploadLevelSlot(cookie: string, id: string): Promise<void> {
  const res = await handler.fetch(request('POST', '/api/cloud/levels', { levelId: id, title: `槽位${id}`, payload: { ...(goodLevel as Record<string, unknown>), id } }, cookie), env, ctx)
  expect(res.status).toBe(201)
}

describe('云盘文件夹 API（docs/39 §5.1）', () => {
  it('未登录任何文件夹操作 → 401', async () => {
    expect((await handler.fetch(request('GET', '/api/cloud/folders'), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), 't')), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('GET', '/api/cloud/folders/cldf_X'), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('DELETE', '/api/cloud/folders/cldf_X'), env, ctx)).status).toBe(401)
  })

  it('上传正例：201 + cldf_ 槽位 + 合并口径 used；列表并入 folders', async () => {
    const cookie = await registerUser('小明')
    const res = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '我的系列', 2, 2), cookie), env, ctx)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { folder: { id: string; folderId: string; levelCount: number; bytes: number }; used: number }
    expect(body.folder.id).toMatch(/^cldf_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body.folder.folderId).toBe(resId(1))
    expect(body.folder.levelCount).toBe(4)
    expect(body.used).toBe(4)
    expect(db.cloud_folders).toHaveLength(1)
    expect(db.cloud_folder_docs).toHaveLength(1 + 2 + 4)
    expect(typeof db.cloud_folder_docs[0].payload).toBe('string')

    // 并入关卡列表端点
    const list = await handler.fetch(request('GET', '/api/cloud/levels', undefined, cookie), env, ctx)
    const listBody = (await list.json()) as { levels: unknown[]; folders: { folderId: string; levelCount: number }[]; used: number; limit: number }
    expect(listBody.levels).toHaveLength(0)
    expect(listBody.folders).toHaveLength(1)
    expect(listBody.folders[0].levelCount).toBe(4)
    expect(listBody.used).toBe(4)
    expect(listBody.limit).toBe(10)

    // 独立列表端点
    const lf = await handler.fetch(request('GET', '/api/cloud/folders', undefined, cookie), env, ctx)
    expect(((await lf.json()) as { folders: unknown[] }).folders).toHaveLength(1)
  })

  it('按 folderId 覆盖：200 不占新槽，文档整体替换，槽位按新 level_count 收敛', async () => {
    const cookie = await registerUser('小明')
    const first = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '系列', 2, 2), cookie), env, ctx)
    expect(((await first.json()) as { used: number }).used).toBe(4)

    const again = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '系列·修订', 1, 1), cookie), env, ctx)
    expect(again.status).toBe(200)
    const body = (await again.json()) as { folder: { title: string; levelCount: number }; used: number }
    expect(body.folder.title).toBe('系列·修订')
    expect(body.folder.levelCount).toBe(1)
    expect(body.used).toBe(1)
    expect(db.cloud_folders).toHaveLength(1)
    expect(db.cloud_folder_docs).toHaveLength(1 + 1 + 1) // 系列 + 专题 + 关卡
  })

  it('闭包校验：缺专题 / 缺关卡 / 多余文档 / 非恰一系列 / 系列与 folderId 不一致 → 400', async () => {
    const cookie = await registerUser('小明')

    const missingTopic = folderBody(resId(1), 't')
    missingTopic.docs = docEntries(missingTopic).filter((d) => d.kind !== 'topic')
    const r1 = await handler.fetch(request('POST', '/api/cloud/folders', missingTopic, cookie), env, ctx)
    expect(r1.status).toBe(400)
    expect(((await r1.json()) as { error: { message: string } }).error.message).toContain('缺件')

    const missingLevel = folderBody(resId(1), 't')
    // 注意：payload 需深拷贝后再改——浅拷贝条目的 content 与共享样本 goodLevel 同引用，
    // 原地改写会毒化本文件后续所有用例（docs[2] 才是专题条目：[系列, 关卡, 专题]）
    const topicEntry = docEntries(missingLevel)[2]
    const topicPayload = JSON.parse(JSON.stringify(topicEntry.payload)) as { content: { levelIds: string[] } }
    topicPayload.content.levelIds = [resId(9999)]
    topicEntry.payload = topicPayload
    const r2 = await handler.fetch(request('POST', '/api/cloud/folders', missingLevel, cookie), env, ctx)
    expect(r2.status).toBe(400)
    expect(((await r2.json()) as { error: { message: string } }).error.message).toContain('缺件')

    const extra = folderBody(resId(1), 't')
    docEntries(extra).push({ id: resId(8888), kind: 'level', payload: { ...(goodLevel as Record<string, unknown>), id: resId(8888) } })
    const r3 = await handler.fetch(request('POST', '/api/cloud/folders', extra, cookie), env, ctx)
    expect(r3.status).toBe(400)
    expect(((await r3.json()) as { error: { message: string } }).error.message).toContain('未被')

    const noSeries = folderBody(resId(1), 't')
    noSeries.docs = docEntries(noSeries).filter((d) => d.kind !== 'series')
    const r4 = await handler.fetch(request('POST', '/api/cloud/folders', noSeries, cookie), env, ctx)
    expect(r4.status).toBe(400)
    expect(((await r4.json()) as { error: { message: string } }).error.message).toContain('series')

    const mismatch = folderBody(resId(2), 't')
    mismatch.folderId = resId(3) // 系列文档 id 为 resId(2)，与请求 folderId(resId(3)) 不一致
    const r5 = await handler.fetch(request('POST', '/api/cloud/folders', mismatch, cookie), env, ctx)
    expect(r5.status).toBe(400)
    expect(((await r5.json()) as { error: { message: string } }).error.message).toContain('不一致')
  })

  it('逐文档闸门：proto 键 / 非法 kind / schema 违例 / id 不一致 / 超体积 / 文档数超限', async () => {
    const cookie = await registerUser('小明')

    const proto = folderBody(resId(1), 't')
    const protoDoc = docEntries(proto)[0].payload as { meta: Record<string, unknown> }
    protoDoc.meta['constructor'] = { evil: true }
    const r1 = await handler.fetch(request('POST', '/api/cloud/folders', proto, cookie), env, ctx)
    expect(r1.status).toBe(400)
    expect(((await r1.json()) as { error: { message: string } }).error.message).toContain('constructor')

    const badKind = folderBody(resId(1), 't')
    docEntries(badKind)[1].kind = 'instrument'
    const r2 = await handler.fetch(request('POST', '/api/cloud/folders', badKind, cookie), env, ctx)
    expect(r2.status).toBe(400)
    expect(((await r2.json()) as { error: { message: string } }).error.message).toContain('kind')

    const badSchema = folderBody(resId(1), 't')
    delete (docEntries(badSchema)[1].payload as { content?: unknown }).content
    const r3 = await handler.fetch(request('POST', '/api/cloud/folders', badSchema, cookie), env, ctx)
    expect(r3.status).toBe(400)
    expect(((await r3.json()) as { error: { code: string } }).error.code).toBe('invalid_doc')

    const idMismatch = folderBody(resId(1), 't')
    docEntries(idMismatch)[1].id = resId(5555)
    const r4 = await handler.fetch(request('POST', '/api/cloud/folders', idMismatch, cookie), env, ctx)
    expect(r4.status).toBe(400)
    expect(((await r4.json()) as { error: { message: string } }).error.message).toContain('不一致')

    const huge = folderBody(resId(1), 't')
    const hugePayload = JSON.parse(JSON.stringify(docEntries(huge)[1].payload)) as { meta: Record<string, unknown> }
    hugePayload.meta.description = 'x'.repeat(520 * 1024)
    docEntries(huge)[1].payload = hugePayload
    const r5 = await handler.fetch(request('POST', '/api/cloud/folders', huge, cookie), env, ctx)
    expect(r5.status).toBe(413)

    const tooMany = folderBody(resId(1), 't', 1, 1)
    const many: Record<string, unknown>[] = [{ id: resId(1), kind: 'series', payload: seriesDoc(resId(1), 't', [resId(100)]) }]
    for (let i = 0; i < 40; i++) many.push({ id: resId(200 + i), kind: 'topic', payload: topicDoc(resId(200 + i), `t${i}`, []) })
    tooMany.docs = many
    const r6 = await handler.fetch(request('POST', '/api/cloud/folders', tooMany, cookie), env, ctx)
    expect(r6.status).toBe(413)
  })

  it('合并槽位上限：关卡槽 + 文件夹混合计数，覆盖按释放量重算', async () => {
    const cookie = await registerUser('小明')
    for (let i = 0; i < 8; i++) await uploadLevelSlot(cookie, resId(50 + i))

    // 8 + 3 > 10 → 409
    const overflow = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '大系列', 1, 3), cookie), env, ctx)
    expect(overflow.status).toBe(409)
    expect(((await overflow.json()) as { error: { code: string } }).error.code).toBe('cloud_full')

    // 8 + 2 = 10 → 201
    const ok = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '系列', 1, 2), cookie), env, ctx)
    expect(ok.status).toBe(201)
    expect(((await ok.json()) as { used: number }).used).toBe(10)

    // 覆盖为 3 关版本：8 + 3 > 10 → 409
    const grow = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '系列·大', 1, 3), cookie), env, ctx)
    expect(grow.status).toBe(409)

    // 覆盖为 1 关版本：8 - 2 + 1 = 9 → 200
    const shrink = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '系列·小', 1, 1), cookie), env, ctx)
    expect(shrink.status).toBe(200)
    expect(((await shrink.json()) as { used: number }).used).toBe(9)
  })

  it('跨用户隔离：他人文件夹 GET/DELETE 一律 404', async () => {
    const cookieA = await registerUser('用户甲')
    const up = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '甲的系列', 1, 1), cookieA), env, ctx)
    const slotId = ((await up.json()) as { folder: { id: string } }).folder.id
    const cookieB = await registerUser('用户乙')

    expect((await handler.fetch(request('GET', `/api/cloud/folders/${slotId}`, undefined, cookieB), env, ctx)).status).toBe(404)
    expect((await handler.fetch(request('DELETE', `/api/cloud/folders/${slotId}`, undefined, cookieB), env, ctx)).status).toBe(404)
    expect(db.cloud_folders).toHaveLength(1)
    expect(db.cloud_folder_docs).toHaveLength(3)
  })

  it('下载回读：docs payload 与上传一致；删除后释放槽位', async () => {
    const cookie = await registerUser('小明')
    const up = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), '系列', 2, 2), cookie), env, ctx)
    const slotId = ((await up.json()) as { folder: { id: string } }).folder.id

    const down = await handler.fetch(request('GET', `/api/cloud/folders/${slotId}`, undefined, cookie), env, ctx)
    expect(down.status).toBe(200)
    const downBody = (await down.json()) as { folder: { folderId: string; levelCount: number }; docs: { id: string; kind: string; payload: { id: string } }[] }
    expect(downBody.folder.folderId).toBe(resId(1))
    expect(downBody.docs).toHaveLength(7) // 1 系列 + 2 专题 + 4 关卡
    const series = downBody.docs.find((d) => d.kind === 'series')!
    expect(series.payload.id).toBe(resId(1))
    expect(downBody.docs.filter((d) => d.kind === 'level')).toHaveLength(4)

    const del = await handler.fetch(request('DELETE', `/api/cloud/folders/${slotId}`, undefined, cookie), env, ctx)
    expect(del.status).toBe(200)
    expect(db.cloud_folders).toHaveLength(0)
    expect(db.cloud_folder_docs).toHaveLength(0)
    const list = await handler.fetch(request('GET', '/api/cloud/levels', undefined, cookie), env, ctx)
    expect(((await list.json()) as { used: number }).used).toBe(0)
    expect((await handler.fetch(request('GET', `/api/cloud/folders/${slotId}`, undefined, cookie), env, ctx)).status).toBe(404)
  })

  it('跨站 Origin 的写请求 → 403 bad_origin（assertSameOrigin 补课）', async () => {
    const cookie = await registerUser('小明')
    const res = await handler.fetch(request('POST', '/api/cloud/folders', folderBody(resId(1), 't'), cookie, 'https://evil.example'), env, ctx)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_origin')
    const resLevel = await handler.fetch(request('POST', '/api/cloud/levels', { levelId: resId(9), title: 't', payload: { ...(goodLevel as Record<string, unknown>), id: resId(9) } }, cookie, 'https://evil.example'), env, ctx)
    expect(resLevel.status).toBe(403)
    expect(db.cloud_folders).toHaveLength(0)
  })
})
