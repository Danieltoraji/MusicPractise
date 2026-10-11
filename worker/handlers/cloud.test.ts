import { beforeEach, describe, expect, it } from 'vitest'
import handler from '../index'
import { D1Fake } from '../testhelpers/d1fake'
import type { Env, ExecutionContext } from '../types'
import goodLevel from '../../src/sample/tutorial-hello.level.json'

/**
 * 云盘 API 集成测试（docs/31 §5.2）：走完整 fetch handler；业务语义（校验闸门、
 * 槽位计数、限流窗口）由模块/单测覆盖，此处固化端到端行为。
 * 注意：云盘写限流为「按尝试计数」（30 次/小时/用户），每个用例独立 env（beforeEach）。
 */

const ORIGIN = 'http://localhost:8787'
const LEVEL_ID = (goodLevel as { id: string }).id

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

function uploadBody(levelId: string, title: string, payload: unknown = goodLevel): Record<string, unknown> {
  return { levelId, title, payload }
}

describe('云盘 API（fetch handler 集成，docs/31 §5.2）', () => {
  it('未登录任何云盘操作 → 401', async () => {
    expect((await handler.fetch(request('GET', '/api/cloud/levels'), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, 't')), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('DELETE', '/api/cloud/levels/cld_X'), env, ctx)).status).toBe(401)
  })

  it('上传正例：201 + 槽位元数据；重复上传同关卡 = 覆盖更新（不占新槽位）', async () => {
    const cookie = await registerUser('小明')
    const res = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, '新手引导'), cookie), env, ctx)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { level: { id: string; levelId: string; title: string }; used: number }
    expect(body.level.id).toMatch(/^cld_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(body.level.levelId).toBe(LEVEL_ID)
    expect(body.used).toBe(1)
    expect(db.cloud_levels).toHaveLength(1)
    expect(typeof db.cloud_levels[0].payload).toBe('string')

    const again = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, '新手引导·修订'), cookie), env, ctx)
    expect(again.status).toBe(200)
    const body2 = (await again.json()) as { used: number; level: { title: string } }
    expect(body2.used).toBe(1)
    expect(body2.level.title).toBe('新手引导·修订')
    expect(db.cloud_levels).toHaveLength(1)
  })

  it('列表与下载：元数据不含 payload；下载回读 payload 与上传一致', async () => {
    const cookie = await registerUser('小明')
    const up = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, '新手引导'), cookie), env, ctx)
    const slotId = ((await up.json()) as { level: { id: string } }).level.id

    const list = await handler.fetch(request('GET', '/api/cloud/levels', undefined, cookie), env, ctx)
    const listBody = (await list.json()) as { levels: { id: string; title: string; payload?: unknown }[]; used: number; limit: number }
    expect(listBody.limit).toBe(10)
    expect(listBody.used).toBe(1)
    expect(listBody.levels[0].title).toBe('新手引导')
    expect(listBody.levels[0]).not.toHaveProperty('payload')

    const down = await handler.fetch(request('GET', `/api/cloud/levels/${slotId}`, undefined, cookie), env, ctx)
    expect(down.status).toBe(200)
    const downBody = (await down.json()) as { level: { levelId: string; payload: { id: string } } }
    expect(downBody.level.payload.id).toBe(LEVEL_ID)
  })

  it('跨用户隔离：他人槽位 GET/PUT/DELETE 一律 404', async () => {
    const cookieA = await registerUser('用户甲')
    const up = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, '甲的关卡'), cookieA), env, ctx)
    const slotId = ((await up.json()) as { level: { id: string } }).level.id
    const cookieB = await registerUser('用户乙')

    const getB = await handler.fetch(request('GET', `/api/cloud/levels/${slotId}`, undefined, cookieB), env, ctx)
    expect(getB.status).toBe(404)
    const putB = await handler.fetch(request('PUT', `/api/cloud/levels/${slotId}`, { title: '篡改', payload: goodLevel }, cookieB), env, ctx)
    expect(putB.status).toBe(404)
    const delB = await handler.fetch(request('DELETE', `/api/cloud/levels/${slotId}`, undefined, cookieB), env, ctx)
    expect(delB.status).toBe(404)
    expect(db.cloud_levels).toHaveLength(1)
  })

  it('10 槽位上限：第 11 个不同关卡 409 cloud_full', async () => {
    const cookie = await registerUser('小明')
    for (let i = 0; i < 10; i++) {
      const id = `res_${String(i).padStart(26, '0')}`
      const res = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(id, `关卡${i}`, { ...(goodLevel as Record<string, unknown>), id }), cookie), env, ctx)
      expect(res.status, `第 ${i + 1} 个槽位应成功`).toBe(201)
    }
    const overflowId = `res_${'9'.repeat(26)}`
    const overflow = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(overflowId, '第11个', { ...(goodLevel as Record<string, unknown>), id: overflowId }), cookie), env, ctx)
    expect(overflow.status).toBe(409)
    expect(((await overflow.json()) as { error: { code: string } }).error.code).toBe('cloud_full')
  })

  it('校验闸门：缺 content 400 invalid_level；危险键 400；levelId 形态 400；payload.id 不一致 400', async () => {
    const cookie = await registerUser('小明')
    const tampered = JSON.parse(JSON.stringify(goodLevel)) as Record<string, unknown>
    delete (tampered as { content?: Record<string, unknown> }).content
    const invalid = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, 't', tampered), cookie), env, ctx)
    expect(invalid.status).toBe(400)
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe('invalid_level')

    const protoPayload = JSON.parse(JSON.stringify(goodLevel)) as { meta: Record<string, unknown> }
    protoPayload.meta['constructor'] = { evil: true }
    const proto = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, 't', protoPayload), cookie), env, ctx)
    expect(proto.status).toBe(400)
    expect(((await proto.json()) as { error: { message: string } }).error.message).toContain('constructor')

    const badId = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody('not-an-id', 't'), cookie), env, ctx)
    expect(badId.status).toBe(400)

    const mismatch = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(`res_${'0'.repeat(25)}9`, 't'), cookie), env, ctx)
    expect(mismatch.status).toBe(400)
    expect(((await mismatch.json()) as { error: { message: string } }).error.message).toContain('不一致')
  })

  it('超体积 payload → 413', async () => {
    const cookie = await registerUser('小明')
    const huge = JSON.parse(JSON.stringify(goodLevel)) as { meta: Record<string, unknown> }
    huge.meta.description = 'x'.repeat(520 * 1024)
    const res = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, 't', huge), cookie), env, ctx)
    expect(res.status).toBe(413)
  })

  it('PUT 覆盖与删除槽位：本人 200/200，之后 GET 404', async () => {
    const cookie = await registerUser('小明')
    const up = await handler.fetch(request('POST', '/api/cloud/levels', uploadBody(LEVEL_ID, 't'), cookie), env, ctx)
    const slotId = ((await up.json()) as { level: { id: string } }).level.id

    const put = await handler.fetch(request('PUT', `/api/cloud/levels/${slotId}`, { title: '改名', payload: goodLevel }, cookie), env, ctx)
    expect(put.status).toBe(200)
    expect(((await put.json()) as { level: { title: string } }).level.title).toBe('改名')

    const del = await handler.fetch(request('DELETE', `/api/cloud/levels/${slotId}`, undefined, cookie), env, ctx)
    expect(del.status).toBe(200)
    expect(db.cloud_levels).toHaveLength(0)
    const get = await handler.fetch(request('GET', `/api/cloud/levels/${slotId}`, undefined, cookie), env, ctx)
    expect(get.status).toBe(404)
  })
})
