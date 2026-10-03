// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../library/db'
import { appendMessage, clearSession, getSession, hydrateSession, patchSession } from './session'

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
