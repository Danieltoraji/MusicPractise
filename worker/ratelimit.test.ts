import { describe, expect, it } from 'vitest'
import { D1Fake } from './testhelpers/d1fake'
import {
  clearLoginFails,
  hitRegisterLimit,
  ipHashOf,
  LOGIN_MAX_FAILS,
  LOGIN_WINDOW_MS,
  loginLockedSeconds,
  recordLoginFail,
  REGISTER_MAX,
} from './ratelimit'
import type { Env } from './types'

const NOW = 1_700_000_000_000
const MINUTE = 60_000

function fakeEnv(): Env {
  return { DB: {} as never, ASSETS: {} as never, IP_HASH_SALT: 'test-salt' }
}

async function ipOf(ip: string): Promise<string> {
  return ipHashOf(new Request('http://localhost/', { headers: { 'CF-Connecting-IP': ip } }), fakeEnv())
}

describe('登录限流（D1 fake，docs/31 §6.4）', () => {
  it('ipHash：不同 IP 不同哈希；同 IP 稳定；CF-Connecting-IP 缺省回落 unknown', async () => {
    const a = await ipOf('1.2.3.4')
    expect(await ipOf('1.2.3.4')).toBe(a)
    expect(await ipOf('5.6.7.8')).not.toBe(a)
    const unknown1 = await ipHashOf(new Request('http://localhost/'), fakeEnv())
    const unknown2 = await ipHashOf(new Request('http://localhost/'), fakeEnv())
    expect(unknown1).toBe(unknown2)
  })

  it(`${LOGIN_MAX_FAILS} 次失败后锁定；不同昵称不连坐`, async () => {
    const db = new D1Fake()
    const ip = await ipOf('1.2.3.4')
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) await recordLoginFail(db, ip, 'alice', NOW + i * MINUTE)
    const locked = await loginLockedSeconds(db, ip, 'alice', NOW + 5 * MINUTE)
    expect(locked).toBeGreaterThan(0)
    expect(await loginLockedSeconds(db, ip, 'bob', NOW + 5 * MINUTE)).toBe(0)
  })

  it('窗口过期自动解锁；窗口内计满后失败不重开窗口', async () => {
    const db = new D1Fake()
    const ip = await ipOf('1.2.3.4')
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) await recordLoginFail(db, ip, 'alice', NOW)
    // 窗口外：解锁，且再次失败重新开窗计数 1
    expect(await loginLockedSeconds(db, ip, 'alice', NOW + LOGIN_WINDOW_MS)).toBe(0)
    await recordLoginFail(db, ip, 'alice', NOW + LOGIN_WINDOW_MS)
    const row = db.login_attempts[0]
    expect(row.fail_count).toBe(1)
    expect(row.window_start).toBe(NOW + LOGIN_WINDOW_MS)

    // 窗口内第 5 次失败后继续失败：窗口起点不变（锁定到原窗口结束，防无限顺延攻击）
    for (let i = 0; i < LOGIN_MAX_FAILS; i++) await recordLoginFail(db, ip, 'alice', NOW + LOGIN_WINDOW_MS + MINUTE)
    const row2 = db.login_attempts[0]
    expect(row2.window_start).toBe(NOW + LOGIN_WINDOW_MS)
    expect(await loginLockedSeconds(db, ip, 'alice', NOW + LOGIN_WINDOW_MS + MINUTE)).toBeGreaterThan(0)
  })

  it('登录成功清零；maybeCleanup 清理过期行', async () => {
    const db = new D1Fake()
    const ip = await ipOf('1.2.3.4')
    await recordLoginFail(db, ip, 'alice', NOW)
    await clearLoginFails(db, ip, 'alice')
    expect(await loginLockedSeconds(db, ip, 'alice', NOW)).toBe(0)

    await recordLoginFail(db, ip, 'old', NOW - 25 * 60 * MINUTE)
    const realRandom = Math.random
    Math.random = () => 0
    try {
      const { maybeCleanupLoginAttempts } = await import('./ratelimit')
      await maybeCleanupLoginAttempts(db, NOW)
    } finally {
      Math.random = realRandom
    }
    expect(db.login_attempts.find((r) => r.key.endsWith(':old'))).toBeUndefined()
  })
})

describe('注册限流（按尝试计数）', () => {
  it(`${REGISTER_MAX} 次内放行，超限锁定至窗口结束；不同 IP 独立`, async () => {
    const db = new D1Fake()
    const ip = await ipOf('9.9.9.9')
    for (let i = 0; i < REGISTER_MAX; i++) {
      expect(await hitRegisterLimit(db, ip, NOW)).toBe(0)
    }
    expect(await hitRegisterLimit(db, ip, NOW + 1)).toBeGreaterThan(0)
    expect(await hitRegisterLimit(db, await ipOf('8.8.8.8'), NOW + 1)).toBe(0)
  })
})
