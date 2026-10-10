import { describe, expect, it } from 'vitest'
import { assertSameOrigin, errorJson, HttpError, jsonResponse, readJsonBody } from './http'

describe('http 工具（错误信封 / 请求体 / Origin 校验）', () => {
  it('jsonResponse 输出 application/json；errorJson 输出 {error:{code,message}}', async () => {
    const ok = jsonResponse({ ok: 1 })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toContain('application/json')
    expect(await ok.json()).toEqual({ ok: 1 })

    const bad = errorJson(404, 'not_found', '接口不存在')
    expect(bad.status).toBe(404)
    expect(await bad.json()).toEqual({ error: { code: 'not_found', message: '接口不存在' } })
  })

  it('HttpError 携带状态码与 code，供入口统一转换', () => {
    const err = new HttpError(401, 'invalid_credentials', '昵称或密码错误')
    expect(err.status).toBe(401)
    expect(err.code).toBe('invalid_credentials')
  })

  it('readJsonBody：合法对象原样返回', async () => {
    const req = new Request('http://localhost/api/x', { method: 'POST', body: '{"a":1}' })
    await expect(readJsonBody(req, 1024)).resolves.toEqual({ a: 1 })
  })

  it('readJsonBody：空体 / 非法 JSON / 非对象一律 400', async () => {
    const post = (body: string) => new Request('http://localhost/api/x', { method: 'POST', body })
    await expect(readJsonBody(post(''), 1024)).rejects.toMatchObject({ status: 400 })
    await expect(readJsonBody(post('not-json'), 1024)).rejects.toMatchObject({ status: 400 })
    await expect(readJsonBody(post('[1,2]'), 1024)).rejects.toMatchObject({ status: 400 })
    await expect(readJsonBody(post('"str"'), 1024)).rejects.toMatchObject({ status: 400 })
    await expect(readJsonBody(post('null'), 1024)).rejects.toMatchObject({ status: 400 })
  })

  it('readJsonBody：实读字节超限 413', async () => {
    const req = new Request('http://localhost/api/x', { method: 'POST', body: 'x'.repeat(100) })
    await expect(readJsonBody(req, 10)).rejects.toMatchObject({ status: 413, code: 'too_large' })
  })

  it('assertSameOrigin：GET/HEAD 放行；无 Origin 放行（curl 等非浏览器客户端）', () => {
    expect(() => assertSameOrigin(new Request('http://h.com/api/x'))).not.toThrow()
    expect(() => assertSameOrigin(new Request('http://h.com/api/x', { method: 'POST', body: '{}' }))).not.toThrow()
  })

  it('assertSameOrigin：Origin 与请求目标同源放行（Host 头缺省时回落 URL host）', () => {
    const req = new Request('http://localhost:8787/api/auth/login', {
      method: 'POST',
      body: '{}',
      headers: { Origin: 'http://localhost:8787' },
    })
    expect(() => assertSameOrigin(req)).not.toThrow()
  })

  it('assertSameOrigin：跨站 Origin 403；非法 Origin 403', () => {
    const cross = new Request('http://localhost:8787/api/auth/login', {
      method: 'POST',
      body: '{}',
      headers: { Origin: 'http://evil.example' },
    })
    expect(() => assertSameOrigin(cross)).toThrowError(HttpError)
    expect(() => assertSameOrigin(cross)).toThrowError(/跨站/)

    const invalid = new Request('http://localhost:8787/api/auth/login', {
      method: 'POST',
      body: '{}',
      headers: { Origin: '::not-a-url' },
    })
    expect(() => assertSameOrigin(invalid)).toThrowError(/Origin/)
  })
})
