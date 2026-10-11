// @vitest-environment node
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, ApiUnavailableError } from '../api/client'
import { getSyncSnapshot, resetSyncForTests } from '../cloud/progress'
import {
  changePassword,
  getAccountSnapshot,
  login,
  logout,
  probeAccount,
  register,
  resetAccountForTests,
  subscribeAccount,
  updateNickname,
} from './store'

/** 轮询等待异步 void 链（syncProgressOnce 是 fire-and-forget） */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 按请求路径路由的 fetch 桩 */
function stubFetchByPath(routes: Record<string, (init: RequestInit) => Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const handler = routes[path] ?? routes[path.replace(/^https?:\/\/[^/]+/, '')]
      if (!handler) throw new TypeError(`fetch 桩未覆盖路径: ${path}`)
      return handler(init ?? {})
    }),
  )
}

const USER = { id: 'usr_A', nickname: '阿明', role: 'user' }

beforeEach(() => {
  resetAccountForTests()
  resetSyncForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('账户 store（探测三态 + 动作流转）', () => {
  it('health 不通 → unavailable；重复探测是 no-op', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => { calls++; throw new TypeError('fetch failed') }))
    await probeAccount()
    await probeAccount()
    expect(getAccountSnapshot().phase).toBe('unavailable')
    expect(getAccountSnapshot().user).toBeNull()
    expect(calls).toBe(1)
  })

  it('health 通 + me 有用户 → available 已登录；me 空 → available 未登录', async () => {
    stubFetchByPath({
      '/api/health': () => jsonResponse({ ok: true }),
      '/api/auth/me': () => jsonResponse({ user: USER }),
    })
    await probeAccount()
    expect(getAccountSnapshot()).toMatchObject({ phase: 'available', user: USER })

    resetAccountForTests()
    stubFetchByPath({
      '/api/health': () => jsonResponse({ ok: true }),
      '/api/auth/me': () => jsonResponse({ user: null }),
    })
    await probeAccount()
    expect(getAccountSnapshot()).toMatchObject({ phase: 'available', user: null })
  })

  it('health 通但 me 异常 → 按 available 未登录处理', async () => {
    stubFetchByPath({
      '/api/health': () => jsonResponse({ ok: true }),
      '/api/auth/me': () => new Response('boom', { status: 500 }),
    })
    await probeAccount()
    expect(getAccountSnapshot()).toMatchObject({ phase: 'available', user: null })
  })

  it('login 成功写入 user；失败抛 ApiError 且不改 user', async () => {
    stubFetchByPath({
      '/api/health': () => jsonResponse({ ok: true }),
      '/api/auth/me': () => jsonResponse({ user: null }),
    })
    await probeAccount()

    stubFetchByPath({
      '/api/auth/login': (init) => {
        const body = JSON.parse(String(init.body)) as { nickname: string }
        if (body.nickname === '阿明') return jsonResponse({ user: USER })
        return jsonResponse({ error: { code: 'invalid_credentials', message: '昵称或密码错误' } }, 401)
      },
    })
    await login('阿明', 'password-123')
    expect(getAccountSnapshot().user?.nickname).toBe('阿明')

    await expect(login('别人', 'password-123')).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(getAccountSnapshot().user?.nickname).toBe('阿明')
    expect(getAccountSnapshot().busy).toBe(false)
  })

  it('register/login/logout/updateNickname 全链路；changePassword 透传', async () => {
    stubFetchByPath({
      '/api/health': () => jsonResponse({ ok: true }),
      '/api/auth/me': () => jsonResponse({ user: null }),
    })
    await probeAccount()

    stubFetchByPath({
      '/api/auth/register': () => jsonResponse({ user: USER }, 201),
      '/api/auth/logout': () => jsonResponse({ ok: true }),
      '/api/auth/nickname': () => jsonResponse({ user: { ...USER, nickname: '新名字' } }),
      '/api/auth/password': () => jsonResponse({ ok: true }),
    })
    await register('阿明', 'password-123')
    expect(getAccountSnapshot().user?.nickname).toBe('阿明')

    await updateNickname('新名字')
    expect(getAccountSnapshot().user?.nickname).toBe('新名字')

    await expect(changePassword('old-123456', 'new-123456')).resolves.toBeUndefined()

    await logout()
    expect(getAccountSnapshot().user).toBeNull()
  })

  it('订阅通知：commit 触发监听器，退订后不再通知', async () => {
    const seen: unknown[] = []
    const unsub = subscribeAccount(() => seen.push(getAccountSnapshot()))
    stubFetchByPath({
      '/api/health': () => { throw new TypeError('fetch failed') },
    })
    await probeAccount()
    unsub()
    await probeAccount() // 已探测过，no-op
    expect(seen.length).toBe(1)
    expect((seen[0] as { phase: string }).phase).toBe('unavailable')
  })

  it('登录成功触发通关记录同步（批次 B3）', async () => {
    stubFetchByPath({
      '/api/health': () => jsonResponse({ ok: true }),
      '/api/auth/me': () => jsonResponse({ user: null }),
    })
    await probeAccount()

    stubFetchByPath({
      '/api/auth/login': () => jsonResponse({ user: USER }),
      '/api/progress': (init) =>
        (init.method ?? 'GET').toUpperCase() === 'PUT' ? jsonResponse({ ok: true }) : jsonResponse({ records: [] }),
    })
    await login('阿明', 'password-123')
    await waitFor(() => getSyncSnapshot().status === 'ok')
    expect(getSyncSnapshot().status).toBe('ok')
  })

  it('ApiError 原样穿透（不被包装成 ApiUnavailableError）', async () => {
    stubFetchByPath({
      '/api/health': () => jsonResponse({ ok: true }),
      '/api/auth/me': () => jsonResponse({ user: null }),
      '/api/auth/login': () => jsonResponse({ error: { code: 'invalid_credentials', message: '昵称或密码错误' } }, 401),
    })
    await probeAccount()
    const err = await login('阿明', 'bad').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).not.toBeInstanceOf(ApiUnavailableError)
  })
})
