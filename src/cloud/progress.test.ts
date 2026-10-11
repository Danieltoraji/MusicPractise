// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type ProgressRecord } from '../library/db'
import { getSyncSnapshot, mergeProgress, pushProgress, resetSyncForTests, syncProgressOnce } from './progress'

function rec(levelId: string, bestScore: number, passed: 0 | 1, attempts: number, updatedAt: number): ProgressRecord {
  return { levelId: `res_${levelId}`, bestScore, passed, attempts, updatedAt }
}

/** fetch 桩：记录 PUT 体，按路径响应 */
let capturedPuts: unknown[] = []
let cloudRecords: unknown[] = []
let failNext = false

beforeEach(async () => {
  resetSyncForTests()
  capturedPuts = []
  cloudRecords = []
  failNext = false
  await Promise.all([db.progress.clear(), db.resources.clear()])
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failNext) throw new TypeError('fetch failed')
      const path = String(input).replace(/^https?:\/\/[^/]+/, '')
      if (path === '/api/progress' && (init?.method ?? 'GET') === 'PUT') {
        capturedPuts.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ ok: true }))
      }
      if (path === '/api/progress') return new Response(JSON.stringify({ records: cloudRecords }))
      throw new TypeError(`fetch 桩未覆盖 ${init?.method ?? 'GET'} ${path}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('mergeProgress（单调合并纯函数，与服务端 ON CONFLICT MAX 同规则）', () => {
  const local = { bestScore: 90, passed: 0, attempts: 1, updatedAt: 2000 }
  const cloud = { bestScore: 40, passed: 1, attempts: 7, updatedAt: 3000 }

  it('各字段取 max：分数取高、passed 取或、attempts 取多、时间取新', () => {
    expect(mergeProgress(local, cloud)).toEqual({ bestScore: 90, passed: 1, attempts: 7, updatedAt: 3000 })
  })

  it('可交换：A+B === B+A；幂等：merge(A, merge(A,B)) === merge(A,B)', () => {
    const ab = mergeProgress(local, cloud)
    const ba = mergeProgress(cloud, local)
    expect(ab).toEqual(ba)
    expect(mergeProgress(ab, cloud)).toEqual(ab)
    expect(mergeProgress(local, ab)).toEqual(ab)
  })

  it('本地缺失：返回云端本身', () => {
    expect(mergeProgress(undefined, cloud)).toEqual(cloud)
  })
})

describe('syncProgressOnce（全量拉取 → 合并 → 差异回推）', () => {
  it('双端交错收敛：云端旧值并入本地新值后回推；本地独有关卡上传；状态 ok', async () => {
    // 本地：resA 是本地领先的记录
    await db.progress.put(rec('A'.padEnd(26, '0'), 90, 0, 1, 2000))
    // 云端：resA 是云端另一设备的记录（分数低/已通过/次数多/时间旧）+ resB 本地没有
    cloudRecords = [
      { levelId: `res_${'A'.padEnd(26, '0')}`, bestScore: 50, passed: 1, attempts: 5, updatedAt: 1000 },
      { levelId: `res_${'B'.padEnd(26, '0')}`, bestScore: 70, passed: 1, attempts: 2, updatedAt: 3000 },
    ]
    await syncProgressOnce()
    expect(getSyncSnapshot().status).toBe('ok')

    // 本地：resA 被合并为 max；resB 从云端写入
    const a = await db.progress.get(`res_${'A'.padEnd(26, '0')}`)
    expect(a).toEqual({ levelId: `res_${'A'.padEnd(26, '0')}`, bestScore: 90, passed: 1, attempts: 5, updatedAt: 2000 })
    const b = await db.progress.get(`res_${'B'.padEnd(26, '0')}`)
    expect(b).toEqual({ levelId: `res_${'B'.padEnd(26, '0')}`, bestScore: 70, passed: 1, attempts: 2, updatedAt: 3000 })

    // 回推：仅 resA 的合并结果领先云端需要推送（resB 与云端一致不推）
    expect(capturedPuts).toHaveLength(1)
    expect((capturedPuts[0] as { records: unknown[] }).records).toEqual([
      { levelId: `res_${'A'.padEnd(26, '0')}`, bestScore: 90, passed: 1, attempts: 5, updatedAt: 2000 },
    ])
  })

  it('本地独有关卡（云端还没有该记录）会被上传', async () => {
    await db.progress.put(rec('C'.padEnd(26, '0'), 10, 0, 1, 5000))
    cloudRecords = []
    await syncProgressOnce()
    expect(capturedPuts).toHaveLength(1)
    expect((capturedPuts[0] as { records: unknown[] }).records).toEqual([
      { levelId: `res_${'C'.padEnd(26, '0')}`, bestScore: 10, passed: 0, attempts: 1, updatedAt: 5000 },
    ])
  })

  it('失败：状态 error，本地数据不动', async () => {
    await db.progress.put(rec('D'.padEnd(26, '0'), 1, 0, 1, 1))
    failNext = true
    await syncProgressOnce()
    expect(getSyncSnapshot().status).toBe('error')
    expect(await db.progress.count()).toBe(1)
    expect(capturedPuts).toHaveLength(0)
  })
})

describe('pushProgress（通关上报，fire-and-forget）', () => {
  it('上报单条 PUT', async () => {
    await pushProgress(rec('E'.padEnd(26, '0'), 88, 1, 2, 12345))
    expect(capturedPuts).toHaveLength(1)
    expect(capturedPuts[0]).toEqual({
      records: [{ levelId: `res_${'E'.padEnd(26, '0')}`, bestScore: 88, passed: 1, attempts: 2, updatedAt: 12345 }],
    })
  })

  it('失败静默：只 console.warn 不抛错', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    failNext = true
    await expect(pushProgress(rec('F'.padEnd(26, '0'), 1, 0, 1, 1))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
