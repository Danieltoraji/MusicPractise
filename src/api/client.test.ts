import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, ApiError, ApiUnavailableError } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('api 客户端（信封解析 / 错误分类 / 超时）', () => {
  it('2xx 返回解析后的 JSON；GET 不带 Content-Type 头', async () => {
    const fetchMock = vi.fn(async (_path: string | URL, _init?: RequestInit) => jsonResponse({ ok: true, value: 42 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(apiFetch('/api/health')).resolves.toEqual({ ok: true, value: 42 })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('GET')
    expect(init.headers).toBeUndefined()
  })

  it('POST 携带 JSON 体与 Content-Type', async () => {
    const fetchMock = vi.fn(async (_path: string | URL, _init?: RequestInit) => jsonResponse({ user: null }))
    vi.stubGlobal('fetch', fetchMock)
    await apiFetch('/api/auth/login', { method: 'POST', body: { nickname: 'a', password: 'b' } })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ nickname: 'a', password: 'b' })
  })

  it('错误信封 → ApiError（code/message/status 可直接用于界面展示）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: { code: 'nickname_taken', message: '昵称已被占用' } }, 409)),
    )
    const err = await apiFetch('/api/auth/register', { method: 'POST', body: {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'nickname_taken', message: '昵称已被占用', status: 409 })
  })

  it('非信封错误响应 → 通用中文消息 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway timeout', { status: 504 })))
    const err = await apiFetch('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ code: 'unknown', status: 504 })
    expect((err as ApiError).message).toContain('504')
  })

  it('网络不可达（TypeError）→ ApiUnavailableError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(apiFetch('/api/health')).rejects.toBeInstanceOf(ApiUnavailableError)
  })

  it('超时触发 abort → ApiUnavailableError', async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_path: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )
    const pending = apiFetch('/api/health', { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).rejects.toBeInstanceOf(ApiUnavailableError)
  })
})
