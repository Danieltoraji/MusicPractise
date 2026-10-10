import { describe, expect, it } from 'vitest'
import { Router } from './router'
import type { Env } from './types'

const env = { DB: {} as never, ASSETS: { fetch: async () => new Response('asset') } } as Env

function get(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method })
}

describe('router（静态段 + :param 段）', () => {
  it('精确匹配静态路径', async () => {
    const r = new Router().add('GET', '/api/auth/me', () => new Response('me'))
    const res = await r.handle(get('/api/auth/me'), env)
    expect(await res?.text()).toBe('me')
  })

  it('方法不匹配 → null；段数不匹配 → null；未知段不匹配 → null', async () => {
    const r = new Router().add('GET', '/api/auth/me', () => new Response('me'))
    expect(await r.handle(get('/api/auth/me', 'POST'), env)).toBeNull()
    expect(await r.handle(get('/api/auth'), env)).toBeNull()
    expect(await r.handle(get('/api/auth/me/extra'), env)).toBeNull()
    expect(await r.handle(get('/api/auth/other'), env)).toBeNull()
  })

  it(':param 段捕获并 decodeURIComponent', async () => {
    const r = new Router().add('DELETE', '/api/cloud/levels/:id', ({ params }) => new Response(params.id ?? ''))
    const res = await r.handle(get('/api/cloud/levels/abc%2Fdef', 'DELETE'), env)
    expect(await res?.text()).toBe('abc/def')
  })

  it('handler 收到 req/env/params', async () => {
    let seen: { method: string; hasEnv: boolean; id: string } | null = null
    const r = new Router().add('POST', '/api/x/:id', ({ req, env: e, params }) => {
      seen = { method: req.method, hasEnv: e === env, id: params.id ?? '' }
      return new Response('ok')
    })
    await r.handle(get('/api/x/42', 'POST'), env)
    expect(seen).toEqual({ method: 'POST', hasEnv: true, id: '42' })
  })
})
