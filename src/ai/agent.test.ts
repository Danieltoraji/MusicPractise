import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentTurn, stopAgent } from './agent'
import type { AiProfileConfig } from './client'
import { appendMessage, clearSession, getSession } from './session'
import type { AiTool, ToolContext } from './tools'
import type { LevelDoc } from '../engine/level'

const profile: AiProfileConfig = { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'sk-t' }

function scriptFetch(responses: unknown[]): ReturnType<typeof vi.fn> {
  let i = 0
  const fn = vi.fn(async () => {
    const payload = responses[Math.min(i, responses.length - 1)]
    i += 1
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

interface ToolCallResponse {
  choices: { message: { content: string; tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] } }[]
}

function toolCall(id: string, name: string, args = '{}'): ToolCallResponse {
  return { choices: [{ message: { content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: args } }] } }] }
}

const fakeTool: AiTool = {
  name: 'fake_read',
  description: '读点什么',
  parameters: { type: 'object', properties: {} },
  exec: () => '工具结果文本',
}

const ctx: ToolContext = { getDoc: () => ({}) as LevelDoc, applyDoc: () => {}, levelId: 'res_agent' }

beforeEach(() => {
  clearSession('res_agent')
  clearSession('res_agent_max')
  clearSession('res_agent_bad')
  clearSession('res_agent_err')
  clearSession('res_agent_stop')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('runAgentTurn', () => {
  it('工具调用→回填→文本终止的完整消息序列', async () => {
    const fn = scriptFetch([toolCall('c1', 'fake_read'), { choices: [{ message: { content: '结论是……' } }] }])
    await runAgentTurn({ docId: 'res_agent', profile, systemPrompt: 'SYS', userText: '看看', tools: [fakeTool], ctx })
    const s = getSession('res_agent')
    expect(s.busy).toBe(false)
    expect(s.error).toBeNull()
    expect(s.messages).toHaveLength(4)
    expect(s.messages[0]).toMatchObject({ role: 'user', content: '看看' })
    expect(s.messages[1]).toMatchObject({ role: 'assistant', content: '' })
    expect(s.messages[1].toolCalls![0].function.name).toBe('fake_read')
    expect(s.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'c1', name: 'fake_read', content: '工具结果文本' })
    expect(s.messages[3]).toMatchObject({ role: 'assistant', content: '结论是……' })
    // 第二次请求带上了 system + 全部历史（含 tool 角色）
    const init2 = (fn.mock.calls[1] as unknown[])[1] as { body: string }
    const body2 = JSON.parse(init2.body)
    expect(body2.messages[0].role).toBe('system')
    expect(body2.messages.some((m: { role: string; tool_call_id?: string }) => m.role === 'tool' && m.tool_call_id === 'c1')).toBe(true)
  })

  it('未知工具名与工具执行异常都转为文本结果回喂模型', async () => {
    scriptFetch([toolCall('c1', 'nope'), toolCall('c2', 'fake_read'), { choices: [{ message: { content: 'ok' } }] }])
    const throwing: AiTool = { ...fakeTool, name: 'fake_read', exec: () => { throw new Error('boom') } }
    await runAgentTurn({ docId: 'res_agent_bad', profile, systemPrompt: 'S', userText: 'go', tools: [throwing], ctx })
    const msgs = getSession('res_agent_bad').messages
    expect(msgs[2]).toMatchObject({ role: 'tool', content: expect.stringContaining('未知工具') })
    expect(msgs[4]).toMatchObject({ role: 'tool', content: expect.stringContaining('boom') })
  })

  it('maxTurns 用尽：追加停止说明且不再请求', async () => {
    const fn = scriptFetch([toolCall('c1', 'fake_read')])
    await runAgentTurn({ docId: 'res_agent_max', profile, systemPrompt: 'S', userText: 'go', tools: [fakeTool], ctx, maxTurns: 1 })
    const s = getSession('res_agent_max')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('停止') })
  })

  it('供应商错误进 session.error 且 busy 复位', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })),
    )
    await runAgentTurn({ docId: 'res_agent_err', profile, systemPrompt: 'S', userText: 'go', tools: [fakeTool], ctx })
    const s = getSession('res_agent_err')
    expect(s.error).toContain('鉴权失败')
    expect(s.busy).toBe(false)
    // user 消息保留（错误不吞输入）
    expect(s.messages[0]).toMatchObject({ role: 'user' })
  })

  it('stopAgent 中断：错误为「已停止」且 busy 复位', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: unknown, init?: { signal?: AbortSignal }) =>
          new Promise((_res, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
          }),
      ),
    )
    const running = runAgentTurn({ docId: 'res_agent_stop', profile, systemPrompt: 'S', userText: 'go', tools: [fakeTool], ctx })
    await new Promise((r) => setTimeout(r, 10))
    stopAgent('res_agent_stop')
    await running
    const s = getSession('res_agent_stop')
    expect(s.error).toBe('已停止。')
    expect(s.busy).toBe(false)
  })

  it('busy 期间重入直接忽略', async () => {
    const fn = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_res, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }),
    )
    vi.stubGlobal('fetch', fn)
    const first = runAgentTurn({ docId: 'res_agent', profile, systemPrompt: 'S', userText: 'a', tools: [fakeTool], ctx })
    await new Promise((r) => setTimeout(r, 10))
    await runAgentTurn({ docId: 'res_agent', profile, systemPrompt: 'S', userText: 'b', tools: [fakeTool], ctx })
    expect(fn).toHaveBeenCalledTimes(1)
    stopAgent('res_agent')
    await first
  })
})

describe('agent 图像消息（批次5）', () => {
  it('工具 emitImages → 带图 user 消息追加（面板与多模态模型可见）', async () => {
    clearSession('res_agent_img')
    let call = 0
    const fn = vi.fn(async () => {
      let payload: unknown
      if (call === 0) {
        payload = {
          choices: [
            {
              message: {
                content: '',
                tool_calls: [{ id: 's1', type: 'function', function: { name: 'shot_tool', arguments: '{}' } }],
              },
            },
          ],
        }
      } else payload = { choices: [{ message: { content: '我看过截图了。' } }] }
      call += 1
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fn)

    const shotTool: AiTool = {
      name: 'shot_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      exec: (_a, c) => {
        c.emitImages?.(['data:image/png;base64,AAA'])
        return '✓ 截图已捕获'
      },
    }
    await runAgentTurn({
      docId: 'res_agent_img',
      profile,
      systemPrompt: 'S',
      userText: '截个图',
      tools: [shotTool],
      ctx: { getDoc: () => ({}) as LevelDoc, applyDoc: () => {}, levelId: 'res_agent_img' },
    })
    const s = getSession('res_agent_img')
    // 消息序列：user → assistant(tool_calls) → tool → user(带图) → assistant(分析)
    expect(s.messages).toHaveLength(5)
    expect(s.messages[3]).toMatchObject({ role: 'user', images: ['data:image/png;base64,AAA'] })
    expect(s.messages[4]).toMatchObject({ role: 'assistant', content: '我看过截图了。' })
    // 序列化：带图消息 content 为 multimodal 数组
    const body = JSON.parse(((fn.mock.calls[1] as unknown[])[1] as { body: string }).body)
    const imgMsg = body.messages.find((m: { content: unknown }) => Array.isArray(m.content))
    expect(imgMsg.content[0]).toMatchObject({ type: 'text' })
    expect(imgMsg.content[1]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } })
    clearSession('res_agent_img')
  })
})

describe('agent 用户附图（批次8a）', () => {
  it('opts.images 随 user 消息入会话，并以 multimodal content 发给模型', async () => {
    clearSession('res_agent_att')
    const fn = scriptFetch([{ choices: [{ message: { content: '我看到图了。' } }] }])
    await runAgentTurn({
      docId: 'res_agent_att',
      profile,
      systemPrompt: 'S',
      userText: '看看这张图',
      images: ['data:image/jpeg;base64,BBB'],
      tools: [],
      ctx,
    })
    expect(getSession('res_agent_att').messages[0]).toMatchObject({
      role: 'user',
      content: '看看这张图',
      images: ['data:image/jpeg;base64,BBB'],
    })
    const body = JSON.parse(((fn.mock.calls[0] as unknown[])[1] as { body: string }).body)
    expect(body.messages[1].content[1]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } })
    clearSession('res_agent_att')
  })

  it('不带 userText 时不追加 user 消息（失败重试续跑现有历史的路径）', async () => {
    clearSession('res_agent_retry')
    // 预置历史（模拟上一轮失败后残留的 user 消息）
    appendMessage('res_agent_retry', { role: 'user', content: '上一轮的问题' })
    const fn = scriptFetch([{ choices: [{ message: { content: '续跑成功。' } }] }])
    await runAgentTurn({ docId: 'res_agent_retry', profile, systemPrompt: 'S', tools: [], ctx })
    const msgs = getSession('res_agent_retry').messages
    // 没有重复插入 user 消息：历史只有预置的 1 条 + 本轮 assistant 回复
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ role: 'user', content: '上一轮的问题' })
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: '续跑成功。' })
    // 模型收到的 user 消息仍是那一条（未重复）
    const body = JSON.parse(((fn.mock.calls[0] as unknown[])[1] as { body: string }).body)
    expect(body.messages.filter((m: { role: string }) => m.role === 'user')).toHaveLength(1)
    clearSession('res_agent_retry')
  })
})

describe('agent 流式（批次6a）', () => {
  function sseResponseText(deltas: string[], delayMs = 0): Response {
    const enc = new TextEncoder()
    const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`)
    lines.push('data: [DONE]\n\n')
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        if (delayMs <= 0) {
          for (const l of lines) c.enqueue(enc.encode(l))
          c.close()
          return
        }
        // 逐段延迟：让流式中间态可观察
        let i = 0
        const push = (): void => {
          if (i >= lines.length) {
            c.close()
            return
          }
          c.enqueue(enc.encode(lines[i]))
          i += 1
          setTimeout(push, delayMs)
        }
        push()
      },
    })
    return new Response(stream, { status: 200 })
  }

  it('流式文本轮：占位 streaming → 打字机增量 → 定稿清除标记', async () => {
    clearSession('res_agent_stream')
    vi.stubGlobal('fetch', vi.fn(async () => sseResponseText(['正在', '修改…'], 120)))
    const running = runAgentTurn({
      docId: 'res_agent_stream',
      profile,
      systemPrompt: 'S',
      userText: 'go',
      tools: [fakeTool],
      ctx,
      stream: true,
    })
    // 中间态：streaming 占位已出现（首 delta 可能被 40ms 合帧暂存，content 可为空）
    await new Promise((r) => setTimeout(r, 60))
    const mid = getSession('res_agent_stream').messages.at(-1)
    expect(mid).toMatchObject({ role: 'assistant', streaming: true })
    await running
    const msgs = getSession('res_agent_stream').messages
    expect(msgs).toHaveLength(2)
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: '正在修改…' })
    expect(msgs[1].streaming).toBeUndefined()
  }, 15000)

  it('流式工具轮：SSE 增量 tool_calls 拼接 → 工具执行 → 第二轮文本', async () => {
    clearSession('res_agent_stream2')
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        
        if (call === 0) {
          // SSE：tool_calls 增量（arguments 分片）
          const enc = new TextEncoder()
          const lines = [
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'w9', function: { name: 'fake_read', arguments: '{"x":' } }] } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] })}\n\n`,
            'data: [DONE]\n\n',
          ]
          call += 1
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              for (const l of lines) c.enqueue(enc.encode(l))
              c.close()
            },
          })
          return new Response(stream, { status: 200 })
        }
        // 请求带 stream:true，供应商总是回 SSE（纯文本轮也是）
        const enc2 = new TextEncoder()
        const stream2 = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc2.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: '完成。' } }] })}\n\n`))
            c.enqueue(enc2.encode('data: [DONE]\n\n'))
            c.close()
          },
        })
        call += 1
        return new Response(stream2, { status: 200 })
      }),
    )
    await runAgentTurn({
      docId: 'res_agent_stream2',
      profile,
      systemPrompt: 'S',
      userText: 'go',
      tools: [fakeTool],
      ctx,
      stream: true,
    })
    const msgs = getSession('res_agent_stream2').messages
    expect(msgs[1].toolCalls![0].function).toEqual({ name: 'fake_read', arguments: '{"x":1}' })
    expect(msgs[2]).toMatchObject({ role: 'tool', content: '工具结果文本' })
    expect(msgs[3]).toMatchObject({ role: 'assistant', content: '完成。' })
    expect(msgs.at(-1)!.streaming).toBeUndefined()
  }, 15000)
})