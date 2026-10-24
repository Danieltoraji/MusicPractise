import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildModelMessages, runAgentTurn, stopAgent } from './agent'
import type { AiProfileConfig, ChatMessage } from './client'
import { appendMessage, beginStreamingMessage, clearSession, finalizeStreamingMessage, getSession, streamAppendToLast } from './session'
import type { AiTool, ToolContext } from './tools'
import type { LevelDoc } from '../engine/level'
import { blankLevelDoc, setMeta } from '../editor/docState'

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

  it('maxTurns 用尽：追加停止说明、置位 turnCapHit 且不再请求', async () => {
    const fn = scriptFetch([toolCall('c1', 'fake_read')])
    await runAgentTurn({ docId: 'res_agent_max', profile, systemPrompt: 'S', userText: 'go', tools: [fakeTool], ctx, maxTurns: 1 })
    const s = getSession('res_agent_max')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('上限') })
    expect(s.turnCapHit).toBe(true)
    expect(s.turnCount).toBe(1)
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

describe('轮数预算与撞限续跑', () => {
  it('turnCount 随请求轮次记录，正常结束保留；新 run 开始归零', async () => {
    clearSession('res_agent_turns')
    scriptFetch([toolCall('c1', 'fake_read'), { choices: [{ message: { content: '完成' } }] }])
    await runAgentTurn({ docId: 'res_agent_turns', profile, systemPrompt: 'S', userText: 'go', tools: [fakeTool], ctx })
    expect(getSession('res_agent_turns').turnCount).toBe(2)
    expect(getSession('res_agent_turns').turnCapHit).toBe(false)
    scriptFetch([{ choices: [{ message: { content: '又完成' } }] }])
    await runAgentTurn({ docId: 'res_agent_turns', profile, systemPrompt: 'S', userText: '再来', tools: [fakeTool], ctx })
    expect(getSession('res_agent_turns').turnCount).toBe(1)
    clearSession('res_agent_turns')
  })

  it('撞限后续跑（不传 userText）：复位 turnCapHit，不重复插入 user 消息', async () => {
    clearSession('res_agent_cap')
    scriptFetch([toolCall('c1', 'fake_read')])
    await runAgentTurn({ docId: 'res_agent_cap', profile, systemPrompt: 'S', userText: 'go', tools: [fakeTool], ctx, maxTurns: 1 })
    expect(getSession('res_agent_cap').turnCapHit).toBe(true)
    const fn = scriptFetch([{ choices: [{ message: { content: '接着跑完了' } }] }])
    await runAgentTurn({ docId: 'res_agent_cap', profile, systemPrompt: 'S', tools: [fakeTool], ctx, maxTurns: 1 })
    const s = getSession('res_agent_cap')
    expect(s.turnCapHit).toBe(false)
    expect(fn).toHaveBeenCalledTimes(1)
    // 历史只有最初那条 user 消息（续跑不重复发送）
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(s.messages.at(-1)).toMatchObject({ role: 'assistant', content: '接着跑完了' })
    clearSession('res_agent_cap')
  })
})

describe('运行内写通道（读写链路修复）', () => {
  /** 夹具：getDoc 恒返回旧引用、applyDoc 只记录不回写——模拟 React state 异步提交/面板实例重挂后 ref 停摆 */
  function markTools() {
    const applied: string[] = []
    const base = { id: 'L' } as LevelDoc
    const staleCtx: ToolContext = {
      getDoc: () => base,
      applyDoc: (next) => {
        applied.push(String((next as { tag?: unknown }).tag))
      },
      levelId: 'L',
    }
    const write: AiTool = {
      name: 'write_mark',
      description: '',
      parameters: { type: 'object', properties: { tag: { type: 'string' } } },
      exec: (args, c) => {
        c.applyDoc({ ...c.getDoc(), tag: String(args.tag) } as LevelDoc)
        return `applied=${String(args.tag)}`
      },
    }
    const read: AiTool = {
      name: 'read_mark',
      description: '',
      parameters: { type: 'object', properties: {} },
      exec: (_a, c) => `tag=${String((c.getDoc() as { tag?: unknown }).tag ?? 'none')}`,
    }
    return { staleCtx, applied, tools: [write, read] }
  }

  it('同轮多写入：后一个工具基于前一个写入后的 doc，而非旧快照', async () => {
    clearSession('res_agent_wt')
    const { staleCtx, applied, tools } = markTools()
    scriptFetch([
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'write_mark', arguments: '{"tag":"a"}' } },
                { id: 'c2', type: 'function', function: { name: 'write_mark', arguments: '{"tag":"b"}' } },
                { id: 'c3', type: 'function', function: { name: 'read_mark', arguments: '{}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: '完成' } }] },
    ])
    await runAgentTurn({ docId: 'res_agent_wt', profile, systemPrompt: 'S', userText: 'go', tools, ctx: staleCtx })
    const msgs = getSession('res_agent_wt').messages
    expect(msgs[3]).toMatchObject({ role: 'tool', content: 'applied=b' })
    // 修复前这里读到 tag=none（旧快照）——读写链路丢失更新的直接复现
    expect(msgs[4]).toMatchObject({ role: 'tool', content: 'tag=b' })
    // 外部写路径（编辑器）两笔都收到，最终以最后一笔为准
    expect(applied).toEqual(['a', 'b'])
  })

  it('跨轮保持：同一运行内下一轮读取仍见本轮写入结果', async () => {
    clearSession('res_agent_wt2')
    const { staleCtx, tools } = markTools()
    scriptFetch([
      { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_mark', arguments: '{"tag":"x"}' } }] } }] },
      { choices: [{ message: { content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_mark', arguments: '{}' } }] } }] },
      { choices: [{ message: { content: '完成' } }] },
    ])
    await runAgentTurn({ docId: 'res_agent_wt2', profile, systemPrompt: 'S', userText: 'go', tools, ctx: staleCtx })
    const msgs = getSession('res_agent_wt2').messages
    expect(msgs[4]).toMatchObject({ role: 'tool', content: 'tag=x' })
  })

  it('systemPrompt 函数形态：每轮以运行内最新 doc 现算', async () => {
    clearSession('res_agent_sp')
    const { staleCtx, tools } = markTools()
    const seenTags: string[] = []
    scriptFetch([
      { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_mark', arguments: '{"tag":"t1"}' } }] } }] },
      { choices: [{ message: { content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'write_mark', arguments: '{"tag":"t2"}' } }] } }] },
      { choices: [{ message: { content: '完成' } }] },
    ])
    await runAgentTurn({
      docId: 'res_agent_sp',
      profile,
      systemPrompt: (doc) => {
        seenTags.push(String((doc as { tag?: unknown }).tag ?? 'none'))
        return 'S'
      },
      userText: 'go',
      tools,
      ctx: staleCtx,
    })
    // 三轮请求：第 1 轮尚无写入，第 2/3 轮分别基于最新 runDoc
    expect(seenTags).toEqual(['none', 't1', 't2'])
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
describe('流式中断/失败收尾（docs/40 F2）', () => {
  it('finalizeStreamingMessage：空占位整体移除；半截内容定稿（清 streaming 标记 + 中断注记）', () => {
    clearSession('res_agent_f2a')
    beginStreamingMessage('res_agent_f2a')
    finalizeStreamingMessage('res_agent_f2a')
    expect(getSession('res_agent_f2a').messages).toHaveLength(0)

    beginStreamingMessage('res_agent_f2a')
    streamAppendToLast('res_agent_f2a', '写到一半', true)
    finalizeStreamingMessage('res_agent_f2a')
    const last = getSession('res_agent_f2a').messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.streaming).toBeFalsy()
    expect(last.content).toContain('写到一半')
    expect(last.content).toContain('已中断')
    clearSession('res_agent_f2a')
  })

  it('buildModelMessages 过滤 streaming 占位与空 assistant；纯 tool_calls 消息保留', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', streaming: true }, // 中断残留占位
      { role: 'assistant', content: '' }, // 空幽灵（无内容也无 tool_calls）
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
    ]
    const out = buildModelMessages('S', history)
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant'])
    expect(out.some((m) => m.streaming === true)).toBe(false)
    expect(out[2].toolCalls).toHaveLength(1)
  })

  it('流中途断流（网络错误）：占位定稿收尾，会话不再留永久闪烁的 streaming 幽灵', async () => {
    clearSession('res_agent_f2b')
    const enc = new TextEncoder()
    const chunk = (text: string): Uint8Array => enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`)
    // SSE：两段 delta 间隔 120ms（第二段必过 40ms 合帧门、刷出半截内容），随后流报错——模拟网络中断
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk('正在思'))
        setTimeout(() => {
          c.enqueue(chunk('考着'))
          setTimeout(() => c.error(new Error('network dropped')), 80)
        }, 120)
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })))
    await runAgentTurn({
      docId: 'res_agent_f2b',
      profile,
      systemPrompt: 'S',
      userText: 'go',
      tools: [fakeTool],
      ctx,
      stream: true,
    })
    const s = getSession('res_agent_f2b')
    expect(s.error).toContain('network dropped')
    // 修复前：末条永远带 streaming:true（面板光标常闪），重试还会把空 assistant 发给供应商
    expect(s.messages.some((m) => m.streaming === true)).toBe(false)
    const last = s.messages.at(-1)!
    expect(last.content).toContain('正在思')
    expect(last.content).toContain('已中断')
    // 收尾后的消息是合法 assistant——重试下发不会再携带幽灵
    const out = buildModelMessages('S', s.messages)
    expect(out.some((m) => m.streaming === true)).toBe(false)
    clearSession('res_agent_f2b')
  }, 15000)
})

describe('历史预算 buildModelMessages（批次8c）', () => {
  const sys = 'SYS'
  const u = (i: number): ChatMessage => ({ role: 'user', content: `u${i}` })
  const a = (i: number): ChatMessage => ({ role: 'assistant', content: `a${i}` })
  const t = (i: number): ChatMessage => ({ role: 'tool', toolCallId: `c${i}`, name: 'x', content: 'r' })

  it('未超限：原样透传（仅加 system 前缀）', () => {
    const history = [u(0), a(0)]
    const out = buildModelMessages(sys, history)
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ role: 'system', content: 'SYS' })
    expect(out.slice(1)).toEqual(history)
  })

  it('超限：只下发最近窗口，窗口起点前进到第一条 user 消息（不拆 tool 对），附省略说明', () => {
    // 140 条：u/a 交替；窗口起点在第 20 条（恰好 user，无需前进）
    const history: ChatMessage[] = []
    for (let i = 0; i < 70; i++) {
      history.push(u(i))
      history.push(a(i))
    }
    const out = buildModelMessages(sys, history)
    expect(out.length).toBeLessThanOrEqual(2 + 120)
    expect(out[0]).toMatchObject({ role: 'system', content: 'SYS' })
    expect(out[1].role).toBe('system')
    expect(out[1].content).toContain('已省略')
    // 窗口起点必为 user（tool/assistant 打头的残缺序列会被供应商拒绝）
    expect(out[2].role).toBe('user')
    // 末尾完整保留
    expect(out.at(-1)).toEqual(history.at(-1))
    // 会话真源未被裁剪
    expect(history).toHaveLength(140)
  })

  it('两级窗口：近期 48 条 tool 结果保全量，更早的 tool 结果压缩截断且配对结构不动', () => {
    const longTool = (i: number): ChatMessage => ({ role: 'tool', toolCallId: `c${i}`, name: 'x', content: 'R'.repeat(1000) })
    const history: ChatMessage[] = [u(0)]
    for (let i = 0; i < 99; i++) history.push(i % 2 === 0 ? a(i) : longTool(i))
    const out = buildModelMessages(sys, history)
    expect(out).toHaveLength(1 + history.length) // 100 条未超 120 窗口：仅加 system 前缀
    const sent = out.slice(1)
    // 远期 tool（前 52 条内）：截断到 200 字符 + 标记，tool_call_id 原样
    const oldTool = sent.slice(0, sent.length - 48).find((m) => m.role === 'tool')!
    expect(oldTool.content.length).toBeLessThan(300)
    expect(oldTool.content).toContain('已截断')
    expect(oldTool.toolCallId).toBe('c1')
    // 近期 tool（最后 48 条内）：保全量
    const tailTool = sent[sent.length - 2]
    expect(tailTool.role).toBe('tool')
    expect(tailTool.content).toHaveLength(1000)
    // 原 history 未被改动
    expect(history[2].content).toHaveLength(1000)
  })

  it('窗口内没有 user 消息（tool 链尾过长）的极端情况：保完整历史不断对', () => {
    const history: ChatMessage[] = [u(0), ...Array.from({ length: 80 }, (_, i) => t(i))]
    const out = buildModelMessages(sys, history)
    expect(out).toHaveLength(1 + history.length)
    expect(out[0]).toMatchObject({ role: 'system', content: 'SYS' })
  })
})

describe('token 用量累计（批次8c）', () => {
  it('每轮响应的 usage 累加进 session（工具轮+文本轮）', async () => {
    clearSession('res_agent_usage')
    let call = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const payload =
          call === 0
            ? { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fake_read', arguments: '{}' } }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }
            : { choices: [{ message: { content: '完成' } }], usage: { prompt_tokens: 300, completion_tokens: 15 } }
        call += 1
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    await runAgentTurn({ docId: 'res_agent_usage', profile, systemPrompt: 'S', userText: 'go', tools: [fakeTool], ctx })
    expect(getSession('res_agent_usage').usage).toEqual({ promptTokens: 400, completionTokens: 35 })
    clearSession('res_agent_usage')
  })

  it('供应商不返回 usage：session.usage 保持 undefined', async () => {
    clearSession('res_agent_nousage')
    scriptFetch([{ choices: [{ message: { content: '好' } }] }])
    await runAgentTurn({ docId: 'res_agent_nousage', profile, systemPrompt: 'S', userText: 'go', tools: [], ctx })
    expect(getSession('res_agent_nousage').usage).toBeUndefined()
    clearSession('res_agent_nousage')
  })
})

describe('F1 创作者手动编辑冲突（docs/42 §4.3 返工：修订号基准确认）', () => {
  /** 简化编辑器：external doc 为真源，revision 每次文档变更 +1（AI 写入与用户手改同一计数器） */
  function editorHarness(initial: LevelDoc) {
    let external = initial
    let revision = 0
    const applied: LevelDoc[] = []
    const ctx: ToolContext = {
      getDoc: () => external,
      applyDoc: (next) => {
        applied.push(next)
        external = next
        revision += 1
      },
      getRevision: () => revision,
      levelId: 'L',
    }
    /** 模拟创作者手动编辑标题（编辑器 update 的等价：换引用 + 修订号 +1） */
    const userEdit = (title: string): void => {
      external = { ...external, meta: { ...external.meta, title } }
      revision += 1
    }
    return { ctx, applied, userEdit, getExternal: () => external }
  }

  const writeDesc: AiTool = {
    name: 'write_desc',
    description: '',
    parameters: { type: 'object', properties: { desc: { type: 'string' } } },
    exec: (args, c) => {
      const doc = c.getDoc()
      c.applyDoc({ ...doc, meta: { ...doc.meta, description: String(args.desc ?? '') } })
      return `✓ 已写描述 ${String(args.desc ?? '')}`
    },
  }

  const readState: AiTool = {
    name: 'read_state',
    description: '',
    parameters: { type: 'object', properties: {} },
    exec: (_a, c) => {
      const doc = c.getDoc()
      return `title=${String(doc.meta.title)} desc=${String(doc.meta.description ?? '无')}`
    },
  }

  function reply(payload: unknown): Response {
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  function callResponse(id: string, name: string, args: Record<string, unknown> = {}): unknown {
    return {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
          },
        },
      ],
    }
  }

  /** 用户先手改、AI 后写（真实场景，非微窗口）：AI 写 #1 成功后创作者手改标题，AI 写 #2 必须被拒绝 */
  it('AI 写后用户手改标题 → 下一次写入被拒绝（不落盘），结果含冲突提示且用户修改保留', async () => {
    clearSession('res_agent_f1a')
    const base = setMeta(blankLevelDoc(), { title: '原始标题' }) as LevelDoc
    const h = editorHarness(base)
    let call = 0
    const fn = vi.fn(async () => {
      const i = call++
      if (i === 0) return reply(callResponse('c1', 'write_desc', { desc: 'AI说明' }))
      if (i === 1) {
        h.userEdit('用户改的标题') // 两次请求之间：创作者手动编辑
        return reply(callResponse('c2', 'write_desc', { desc: 'AI第二次' }))
      }
      return reply({ choices: [{ message: { content: '完成' } }] })
    })
    vi.stubGlobal('fetch', fn)

    await runAgentTurn({ docId: 'res_agent_f1a', profile, systemPrompt: 'S', userText: 'go', tools: [writeDesc], ctx: h.ctx })
    expect(fn).toHaveBeenCalledTimes(3)

    const msgs = getSession('res_agent_f1a').messages
    const toolMsgs = msgs.filter((m) => m.role === 'tool')
    // 第一笔写入成功、第二笔在工具层被拒（错误回喂模型，附重读指引）
    expect(toolMsgs[0].content).toContain('✓ 已写描述 AI说明')
    expect(toolMsgs[1].content).toContain('编辑器已被手动修改')
    expect(toolMsgs[1].content).toContain('请先 read_doc/read_script 重新读取现状后再修改')
    // 用户修改保留：第二笔未落盘（applied 只有第一笔；标题仍是用户的）
    expect(h.applied).toHaveLength(1)
    expect(h.getExternal().meta.title).toBe('用户改的标题')
    expect(h.getExternal().meta.description).toBe('AI说明')
    clearSession('res_agent_f1a')
  })

  it('冲突后读工具读编辑器实时文档；重读后基于新状态重试成功（用户修改不丢）', async () => {
    clearSession('res_agent_f1b')
    const base = setMeta(blankLevelDoc(), { title: '原始标题' }) as LevelDoc
    const h = editorHarness(base)
    let call = 0
    const fn = vi.fn(async () => {
      const i = call++
      if (i === 0) return reply(callResponse('c1', 'write_desc', { desc: 'AI说明' }))
      if (i === 1) {
        h.userEdit('用户改的标题')
        return reply(callResponse('c2', 'write_desc', { desc: 'AI第二次' }))
      }
      if (i === 2) return reply(callResponse('c3', 'read_state'))
      if (i === 3) return reply(callResponse('c4', 'write_desc', { desc: 'AI重读后' }))
      return reply({ choices: [{ message: { content: '完成' } }] })
    })
    vi.stubGlobal('fetch', fn)

    await runAgentTurn({
      docId: 'res_agent_f1b',
      profile,
      systemPrompt: 'S',
      userText: 'go',
      tools: [writeDesc, readState],
      ctx: h.ctx,
    })
    const toolMsgs = getSession('res_agent_f1b').messages.filter((m) => m.role === 'tool')
    // 冲突态下 read_state 读到的是编辑器实时文档（不是影子 runDoc）
    expect(toolMsgs[2].content).toBe('title=用户改的标题 desc=AI说明')
    // 重读后（无新的手动修改）写入放行：基于实时文档合并，用户标题保留
    expect(toolMsgs[3].content).toContain('✓ 已写描述 AI重读后')
    expect(h.applied).toHaveLength(2)
    expect(h.getExternal().meta.title).toBe('用户改的标题')
    expect(h.getExternal().meta.description).toBe('AI重读后')
    clearSession('res_agent_f1b')
  })
})

describe('F9 提示预算压缩（docs/44 R16b）', () => {
  /** 40 条历史：第 1/2 条是超长 tool_calls + 对应 tool 结果（落在 OVER_BUDGET_TAIL 之外） */
  function historyWithOldPair(): ChatMessage[] {
    const history: ChatMessage[] = [
      { role: 'user', content: '开始' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            id: 'c-old',
            type: 'function',
            function: { name: 'read_json', arguments: JSON.stringify({ payload: 'y'.repeat(900) }) },
          },
        ],
      },
      { role: 'tool', toolCallId: 'c-old', name: 'read_json', content: 'x'.repeat(1000) },
    ]
    for (let i = 0; i < 37; i++) history.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `消息 ${i}` })
    return history
  }

  it('promptTokens 超预算：远期 tool 结果与 tool_calls 参数深度压缩，配对保留、最近消息不动', () => {
    const out = buildModelMessages('S', historyWithOldPair(), { promptTokens: 40_000 })
    const tool = out.find((m) => m.role === 'tool')!
    expect(tool.toolCallId).toBe('c-old')
    expect(tool.content.length).toBeLessThan(400)
    expect(tool.content).toContain('上下文预算紧张')
    const assistant = out.find((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0)!
    expect(assistant.toolCalls![0].id).toBe('c-old')
    const args = assistant.toolCalls![0].function.arguments
    expect(args.length).toBeLessThan(500)
    // 合法 JSON 占位：严格供应商不会因历史参数形状异常 4xx
    expect(JSON.parse(args)).toMatchObject({ _truncated: true })
    // 最近一条消息保持全量（未被预算压缩）
    expect(out.at(-1)!.content).toBe('消息 36')
  })

  it('promptTokens 未超预算：历史原样下发（只有 system 前缀），不产生额外压缩', () => {
    const out = buildModelMessages('S', historyWithOldPair(), { promptTokens: 5_000 })
    const tool = out.find((m) => m.role === 'tool')!
    expect(tool.content).toHaveLength(1000)
    const assistant = out.find((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0)!
    expect(assistant.toolCalls![0].function.arguments.length).toBeGreaterThan(900)
  })

  it('未提供 promptTokens（供应商不返回 usage）：保持旧行为（不启用超预算压缩）', () => {
    const out = buildModelMessages('S', historyWithOldPair())
    const tool = out.find((m) => m.role === 'tool')!
    expect(tool.content).toHaveLength(1000)
  })
})

describe('停止信号的循环内收尾（R5/F5）', () => {
  it('工具执行期间停止：不再发起下一轮请求，工具结果不落会话，错误为「已停止」', async () => {
    clearSession('res_agent_stop_tool')
    const fn = scriptFetch([toolCall('c1', 'slow_tool')])
    const slowTool: AiTool = {
      name: 'slow_tool',
      description: '',
      parameters: { type: 'object', properties: {} },
      exec: async () => {
        stopAgent('res_agent_stop_tool') // 工具执行中显式停止（宿主关闭面板/点停止）
        return '工具完成'
      },
    }
    await runAgentTurn({ docId: 'res_agent_stop_tool', profile, systemPrompt: 'S', userText: 'go', tools: [slowTool], ctx })
    expect(fn).toHaveBeenCalledTimes(1) // 停止后不再发起下一轮
    const s = getSession('res_agent_stop_tool')
    expect(s.error).toBe('已停止。')
    expect(s.busy).toBe(false)
    expect(s.messages.some((m) => m.role === 'tool')).toBe(false)
    clearSession('res_agent_stop_tool')
  })
})

