import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiClientError, chatComplete, chatCompleteRaw, testConnection, type AiProfileConfig } from './client'

const profile: AiProfileConfig = {
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  apiKey: 'sk-test',
}

function mockFetch(payload: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

function calledUrl(fn: ReturnType<typeof vi.fn>): string {
  return (fn.mock.calls[0] as unknown[])[0] as string
}

function calledInit(fn: ReturnType<typeof vi.fn>): RequestInit {
  return (fn.mock.calls[0] as unknown[])[1] as RequestInit
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('chatComplete', () => {
  it('成功：返回 content，请求打到 /chat/completions 且带 Bearer 头', async () => {
    const fn = mockFetch({ choices: [{ message: { content: '你好' } }] })
    const out = await chatComplete(profile, [{ role: 'user', content: 'hi' }])
    expect(out).toBe('你好')
    expect(calledUrl(fn)).toBe('https://api.example.com/v1/chat/completions')
    const init = calledInit(fn)
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer sk-test')
    const body = JSON.parse(init.body as string)
    expect(body.model).toBe('test-model')
    expect(body.stream).toBe(false)
  })

  it('baseUrl 结尾斜杠被规范化，不产生重复斜杠', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    await chatComplete({ ...profile, baseUrl: 'https://api.example.com/v1/' }, [{ role: 'user', content: 'hi' }])
    expect(calledUrl(fn)).toBe('https://api.example.com/v1/chat/completions')
  })

  it('401 → auth 错误，透出供应商 detail', async () => {
    mockFetch({ error: { message: 'Invalid API key' } }, 401)
    const err = await chatComplete(profile, [{ role: 'user', content: 'hi' }]).catch((e) => e)
    expect(err).toBeInstanceOf(AiClientError)
    expect((err as AiClientError).kind).toBe('auth')
    expect((err as AiClientError).message).toContain('Invalid API key')
  })

  it('429 → rate-limit；500 → server；400 带 detail → bad-request', async () => {
    mockFetch({}, 429)
    await expect(chatComplete(profile, [])).rejects.toMatchObject({ kind: 'rate-limit' })
    mockFetch({}, 503)
    await expect(chatComplete(profile, [])).rejects.toMatchObject({ kind: 'server' })
    mockFetch({ error: { message: 'unknown model' } }, 400)
    await expect(chatComplete(profile, [])).rejects.toMatchObject({ kind: 'bad-request' })
  })

  it('响应缺 choices → response 错误', async () => {
    mockFetch({ object: 'chat.completion' })
    await expect(chatComplete(profile, [])).rejects.toMatchObject({ kind: 'response' })
  })

  it('配置缺失直接抛 bad-config，不发起网络请求', async () => {
    const fn = vi.fn()
    vi.stubGlobal('fetch', fn)
    await expect(chatComplete({ ...profile, apiKey: '' }, [])).rejects.toMatchObject({ kind: 'bad-config' })
    await expect(chatComplete({ ...profile, baseUrl: 'ftp://x' }, [])).rejects.toMatchObject({ kind: 'bad-config' })
    await expect(chatComplete({ ...profile, model: ' ' }, [])).rejects.toMatchObject({ kind: 'bad-config' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('fetch 网络层失败 → network 错误，附 CORS 绕行建议', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const err = await chatComplete(profile, []).catch((e) => e)
    expect((err as AiClientError).kind).toBe('network')
    expect((err as AiClientError).message).toContain('跨域')
  })

  it('外部 signal 已中止：透传 AbortError 而非包装成 network', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => {
        throw new DOMException('Aborted', 'AbortError')
      }),
    )
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(chatComplete(profile, [], { signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('testConnection', () => {
  it('返回延迟与去空白应答，body 带 max_tokens', async () => {
    const fn = mockFetch({ choices: [{ message: { content: ' 正常 ' } }] })
    const r = await testConnection(profile)
    expect(r.reply).toBe('正常')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
    const body = JSON.parse(calledInit(fn).body as string)
    expect(body.max_tokens).toBeGreaterThan(0)
    expect(body.messages).toEqual([{ role: 'user', content: '请只回复两个字：正常' }])
  })

  it('非 JSON 错误体也能按状态码归类（403 → auth）', async () => {
    const fn = vi.fn(async () => new Response('gateway says no', { status: 403 }))
    vi.stubGlobal('fetch', fn)
    await expect(testConnection(profile)).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('chatCompleteRaw（function calling）', () => {
  it('tools 声明进入请求体；tool_calls 被结构化解析', async () => {
    const fn = mockFetch({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              { id: 'call1', type: 'function', function: { name: 'read_script', arguments: '{}' } },
              { id: 'call2', type: 'function', function: { name: 'lint', arguments: '{"a":1}' } },
              { broken: true }, // 非法项被过滤
            ],
          },
        },
      ],
    })
    const res = await chatCompleteRaw(profile, [{ role: 'user', content: '看看' }], {
      tools: [{ type: 'function', function: { name: 'read_script', description: '读脚本', parameters: { type: 'object', properties: {} } } }],
    })
    const body = JSON.parse(calledInit(fn).body as string)
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].function.name).toBe('read_script')
    expect(res.content).toBe('')
    expect(res.toolCalls).toHaveLength(2)
    expect(res.toolCalls![0]).toEqual({ id: 'call1', type: 'function', function: { name: 'read_script', arguments: '{}' } })
    expect(res.toolCalls![1].function.arguments).toBe('{"a":1}')
  })

  it('无 tools 参数时请求体不含 tools 键；纯文本响应 toolCalls 为 undefined', async () => {
    const fn = mockFetch({ choices: [{ message: { content: '你好' } }] })
    const res = await chatCompleteRaw(profile, [{ role: 'user', content: 'hi' }])
    expect(JSON.parse(calledInit(fn).body as string).tools).toBeUndefined()
    expect(res).toEqual({ content: '你好' })
  })

  it('tool 角色消息序列化带 tool_call_id', async () => {
    const fn = mockFetch({ choices: [{ message: { content: 'ok' } }] })
    await chatCompleteRaw(
      profile,
      [
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'lint', arguments: '{}' } }] },
        { role: 'tool', toolCallId: 'c1', name: 'lint', content: '结果' },
      ],
      { tools: [{ type: 'function', function: { name: 'lint', description: '', parameters: {} } }] },
    )
    const body = JSON.parse(calledInit(fn).body as string)
    expect(body.messages[1]).toMatchObject({ role: 'tool', tool_call_id: 'c1', name: 'lint' })
  })

  it('content 与 tool_calls 双缺 → response 错误', async () => {
    mockFetch({ choices: [{ message: {} }] })
    await expect(chatCompleteRaw(profile, [])).rejects.toMatchObject({ kind: 'response' })
    await expect(chatComplete(profile, [])).rejects.toMatchObject({ kind: 'response' })
  })
})
