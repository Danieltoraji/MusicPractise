// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../library/db'
import {
  AI_SESSION_SCHEMA_VERSION,
  appendMessage,
  clearSession,
  getSession,
  hydrateSession,
  patchSession,
  sanitizePersistedSession,
  type ChatMessage,
} from './session'

const DOC = 'res_persist'
const flushDb = async (): Promise<void> => {
  // 等防抖（600ms）+ 写入完成
  await new Promise((r) => setTimeout(r, 800))
}

beforeEach(async () => {
  clearSession(DOC)
  await db.aiSessions.clear()
})

describe('会话持久化（批次6b）', () => {
  it('setSession 防抖写入：消息/计划/模式落地', async () => {
    patchSession(DOC, { mode: 'agent' })
    appendMessage(DOC, { role: 'user', content: '你好' })
    appendMessage(DOC, { role: 'assistant', content: '你好呀' })
    patchSession(DOC, {
      mode: 'agent',
      plan: { raw: '', status: 'executing', items: [{ text: '甲', status: 'done', enabled: true }] },
    })
    await flushDb()
    const rec = await db.aiSessions.get(DOC)
    expect(rec?.messages).toHaveLength(2)
    expect(rec?.mode).toBe('agent')
    expect((rec?.plan as { status: string }).status).toBe('executing')
  })

  it('空会话不写库；清空后删除记录', async () => {
    clearSession(DOC)
    await flushDb()
    expect(await db.aiSessions.get(DOC)).toBeUndefined()
    appendMessage(DOC, { role: 'user', content: 'x' })
    await flushDb()
    expect(await db.aiSessions.get(DOC)).toBeTruthy()
    clearSession(DOC)
    await flushDb()
    expect(await db.aiSessions.get(DOC)).toBeUndefined()
  })

  it('hydrate：内存为空时从库恢复消息/计划/模式', async () => {
    const plan = { raw: 'r', status: 'executing' as const, items: [{ text: '甲', status: 'pending', enabled: true }] }
    await db.aiSessions.put({
      docId: DOC,
      messages: [
        { role: 'user', content: '需求' },
        { role: 'assistant', content: '方案' },
      ],
      plan,
      mode: 'agent',
      updatedAt: Date.now(),
    })
    hydrateSession(DOC)
    await new Promise((r) => setTimeout(r, 50))
    const s = getSession(DOC)
    expect(s.messages).toHaveLength(2)
    expect(s.mode).toBe('agent')
    expect(s.plan?.status).toBe('executing')
  })

  it('hydrate 幂等：内存已有消息时不覆盖', async () => {
    appendMessage(DOC, { role: 'user', content: '新消息' })
    await db.aiSessions.put({
      docId: DOC,
      messages: [{ role: 'user', content: '旧消息' }],
      plan: null,
      mode: 'ask',
      updatedAt: Date.now() - 10000,
    })
    hydrateSession(DOC)
    await new Promise((r) => setTimeout(r, 50))
    expect(getSession(DOC).messages[0].content).toBe('新消息')
  })
})

describe('F10 会话持久化版本与结构校验（docs/44 R19）', () => {
  it('持久化记录带 schemaVersion（新写入记录可被未来版本识别）', async () => {
    appendMessage(DOC, { role: 'user', content: 'x' })
    await flushDb()
    const rec = await db.aiSessions.get(DOC)
    expect(rec?.schemaVersion).toBe(AI_SESSION_SCHEMA_VERSION)
  })

  it('sanitizePersistedSession：坏记录逐条清洗（坏角色/空 assistant/缺 toolCallId 的 tool 丢弃，streaming 剥除）', () => {
    const raw = {
      docId: DOC,
      messages: [
        null,
        { role: 'system', content: 'S' },
        { role: 'user', content: '需求' },
        { role: 'assistant', content: '', streaming: true }, // 空 assistant + streaming
        { role: 'tool', content: '结果' }, // 缺 toolCallId
        { role: 'assistant', content: '方案' },
        { role: 'robot', content: '非法角色' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
      ],
      plan: { raw: 'r', status: 'executing', items: [{ text: '甲', status: 'done', enabled: true }, { bad: 1 }] },
      mode: 'agent',
      usage: { promptTokens: 3, completionTokens: 4 },
      updatedAt: 1,
    }
    const rec = sanitizePersistedSession(raw, DOC)!
    expect(rec).not.toBeNull()
    const messages = rec.messages as ChatMessage[]
    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'assistant'])
    expect(messages.every((m) => m.streaming !== true)).toBe(true)
    expect((rec.plan as { items: unknown[] }).items).toHaveLength(1)
    expect(rec.mode).toBe('agent')
    expect(rec.usage).toEqual({ promptTokens: 3, completionTokens: 4 })
  })

  it('hydrate 忽略结构不可用记录与未来版本记录（不把坏数据注入会话）', async () => {
    await db.aiSessions.put({ docId: DOC, messages: ['not-a-message'], plan: null, mode: 'ask', updatedAt: Date.now() } as never)
    hydrateSession(DOC)
    await new Promise((r) => setTimeout(r, 50))
    expect(getSession(DOC).messages).toHaveLength(0)

    clearSession(DOC)
    await db.aiSessions.clear()
    await db.aiSessions.put({
      docId: DOC,
      schemaVersion: AI_SESSION_SCHEMA_VERSION + 1,
      messages: [{ role: 'user', content: '未来版本' }],
      plan: null,
      mode: 'ask',
      updatedAt: Date.now(),
    })
    hydrateSession(DOC)
    await new Promise((r) => setTimeout(r, 50))
    expect(getSession(DOC).messages).toHaveLength(0)
  })

  it('超长消息/过多消息被截断（持久化不无限膨胀）', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }))
    many.push({ role: 'user' as const, content: 'x'.repeat(250_000) })
    const rec = sanitizePersistedSession({ docId: DOC, messages: many, plan: null, mode: 'ask', updatedAt: Date.now() }, DOC)!
    expect(rec.messages.length).toBeLessThanOrEqual(400)
    const last = (rec.messages as ChatMessage[])[rec.messages.length - 1]
    expect(last.content.length).toBeLessThanOrEqual(200_000)
  })
})
