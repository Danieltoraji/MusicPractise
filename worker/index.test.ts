import { describe, expect, it } from 'vitest'
import handler from './index'
import type { Env, ExecutionContext } from './types'

function makeEnv(assetBody: string): Env {
  return {
    DB: {} as never,
    ASSETS: { fetch: async () => new Response(assetBody, { headers: { 'Content-Type': 'text/html' } }) },
  }
}

const ctx: ExecutionContext = {
  waitUntil: () => {},
  passThroughOnException: () => {},
}

describe('worker 入口（/api 分发 + 静态回落 + 错误收口）', () => {
  it('GET /api/health → 200 {ok:true, time}', async () => {
    const res = await handler.fetch(new Request('http://localhost/api/health'), makeEnv('<html>'), ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; time: number }
    expect(body.ok).toBe(true)
    expect(typeof body.time).toBe('number')
  })

  it('未知 /api 路径 → 404 错误信封（不回落 HTML）', async () => {
    const res = await handler.fetch(new Request('http://localhost/api/nope'), makeEnv('<html>'), ctx)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: '接口不存在' } })
  })

  it('方法不匹配的已知路径同样 404 信封', async () => {
    const res = await handler.fetch(new Request('http://localhost/api/health', { method: 'DELETE' }), makeEnv('<html>'), ctx)
    expect(res.status).toBe(404)
  })

  it('非 /api 路径回落 ASSETS 静态资产', async () => {
    const res = await handler.fetch(new Request('http://localhost/some/page'), makeEnv('<html>spa</html>'), ctx)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>spa</html>')
  })
})
