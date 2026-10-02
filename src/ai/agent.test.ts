import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentTurn, stopAgent } from './agent'
import type { AiProfileConfig } from './client'
import { clearSession, getSession } from './session'
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
