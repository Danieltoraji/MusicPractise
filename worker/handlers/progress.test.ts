import { beforeEach, describe, expect, it } from 'vitest'
import handler from '../index'
import { D1Fake } from '../testhelpers/d1fake'
import type { Env, ExecutionContext } from '../types'

/**
 * 通关记录 API 集成测试（docs/31 §5.3）：核心是 ON CONFLICT MAX 单调合并的
 * 端到端行为——幂等、可交换、双端交错收敛（语义镜像由前端 mergeProgress 单测覆盖）。
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

async function registerUser(nickname: string): Promise<string> {
  const res = await handler.fetch(request('POST', '/api/auth/register', { nickname, password: 'password-123' }), env, ctx)
  expect(res.status).toBe(201)
  return cookieOf(res)
}

function rec(levelId: string, bestScore: number, passed: number, attempts: number, updatedAt: number) {
  return { levelId: `res_${levelId}`, bestScore, passed, attempts, updatedAt }
}

type ProgressRecordWire = { levelId: string; bestScore: number; passed: number; attempts: number; updatedAt: number }

async function getRecords(cookie: string): Promise<ProgressRecordWire[]> {
  const res = await handler.fetch(request('GET', '/api/progress', undefined, cookie), env, ctx)
  expect(res.status).toBe(200)
  return ((await res.json()) as { records: ProgressRecordWire[] }).records
}

describe('通关记录 API（fetch handler 集成，docs/31 §5.3）', () => {
  it('未登录 GET/PUT → 401', async () => {
    expect((await handler.fetch(request('GET', '/api/progress'), env, ctx)).status).toBe(401)
    expect((await handler.fetch(request('PUT', '/api/progress', { records: [] }), env, ctx)).status).toBe(401)
  })

  it('PUT 写入 → GET 回读字段同名映射', async () => {
    const cookie = await registerUser('小明')
    const put = await handler.fetch(request('PUT', '/api/progress', { records: [rec('A'.padEnd(26, '0'), 80, 1, 3, 1700000000000)] }, cookie), env, ctx)
    expect(put.status).toBe(200)
    expect(((await put.json()) as { applied: number }).applied).toBe(1)
    const records = await getRecords(cookie)
    expect(records).toEqual([
      { levelId: `res_${'A'.padEnd(26, '0')}`, bestScore: 80, passed: 1, attempts: 3, updatedAt: 1700000000000 },
    ])
  })

  it('幂等：同一批重复 PUT 结果不变', async () => {
    const cookie = await registerUser('小明')
    const batch = { records: [rec('B'.padEnd(26, '0'), 60, 1, 2, 1700000000000)] }
    await handler.fetch(request('PUT', '/api/progress', batch, cookie), env, ctx)
    await handler.fetch(request('PUT', '/api/progress', batch, cookie), env, ctx)
    await handler.fetch(request('PUT', '/api/progress', batch, cookie), env, ctx)
    const records = await getRecords(cookie)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({ levelId: `res_${'B'.padEnd(26, '0')}`, bestScore: 60, passed: 1, attempts: 2, updatedAt: 1700000000000 })
  })

  it('双端交错：各字段按 MAX 收敛（分数取高、passed 取或、attempts 取多、时间取新）', async () => {
    const cookie = await registerUser('小明')
    // 设备 A：高分旧记录
    await handler.fetch(request('PUT', '/api/progress', { records: [rec('C'.padEnd(26, '0'), 90, 0, 1, 1700000010000)] }, cookie), env, ctx)
    // 设备 B：低分新记录（次数更多、已通过）
    await handler.fetch(request('PUT', '/api/progress', { records: [rec('C'.padEnd(26, '0'), 40, 1, 7, 1700000020000)] }, cookie), env, ctx)
    const [merged] = await getRecords(cookie)
    expect(merged).toEqual({ levelId: `res_${'C'.padEnd(26, '0')}`, bestScore: 90, passed: 1, attempts: 7, updatedAt: 1700000020000 })

    // 交换顺序重放：结果一致（可交换）
    await handler.fetch(request('PUT', '/api/progress', { records: [rec('C'.padEnd(26, '0'), 40, 1, 7, 1700000020000)] }, cookie), env, ctx)
    await handler.fetch(request('PUT', '/api/progress', { records: [rec('C'.padEnd(26, '0'), 90, 0, 1, 1700000010000)] }, cookie), env, ctx)
    const [again] = await getRecords(cookie)
    expect(again).toEqual(merged)
  })

  it('反例：records 缺失/超批量/字段非法 → 400', async () => {
    const cookie = await registerUser('小明')
    const noRecords = await handler.fetch(request('PUT', '/api/progress', {}, cookie), env, ctx)
    expect(noRecords.status).toBe(400)
    const tooMany = await handler.fetch(
      request('PUT', '/api/progress', { records: Array.from({ length: 501 }, () => rec('D'.padEnd(26, '0'), 1, 0, 1, 1)) }, cookie),
      env,
      ctx,
    )
    expect(tooMany.status).toBe(400)
    const badField = await handler.fetch(request('PUT', '/api/progress', { records: [{ levelId: 'oops', bestScore: 1, passed: 0, attempts: 1, updatedAt: 1 }] }, cookie), env, ctx)
    expect(badField.status).toBe(400)
    const badPassed = await handler.fetch(
      request('PUT', '/api/progress', { records: [{ levelId: `res_${'E'.padEnd(26, '0')}`, bestScore: 1, passed: 2, attempts: 1, updatedAt: 1 }] }, cookie),
      env,
      ctx,
    )
    expect(badPassed.status).toBe(400)
    expect(db.progress).toHaveLength(0)
  })

  it('用户隔离：各用户进度互不可见', async () => {
    const cookieA = await registerUser('用户甲')
    const cookieB = await registerUser('用户乙')
    await handler.fetch(request('PUT', '/api/progress', { records: [rec('F'.padEnd(26, '0'), 70, 1, 1, 1700000000000)] }, cookieA), env, ctx)
    expect(await getRecords(cookieB)).toEqual([])
    expect(await getRecords(cookieA)).toHaveLength(1)
  })
})
