/**
 * AI 会话 store（批次1「统一对话」的地基）：按 doc.id 键的模块级 Map，
 * 编辑器五个 tab 条件渲染切走即卸载——会话必须跨卸载存活（与 ScriptTab drafts 同款先例）。
 * 消息结构沿用 client.ts 的 OpenAI 兼容 ChatMessage（含 tool 角色），
 * 面板经 subscribe + useSyncExternalStore 订阅更新。
 */

import type { ChatMessage } from './client'

export type { ChatMessage } from './client'

export interface AiSession {
  /** 完整多轮消息（user/assistant/tool），不含 system——system 每次请求现组装 */
  messages: ChatMessage[]
  /** agent 循环进行中：面板据此禁用发送、显示停止按钮 */
  busy: boolean
  /** 最近一次错误的可读文案；null = 无错误 */
  error: string | null
}

const sessions = new Map<string, AiSession>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

export function subscribeAiSession(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 取会话（不存在则建空会话）；返回稳定引用，仅在更新时替换——可直接当 useSyncExternalStore 快照 */
export function getSession(docId: string): AiSession {
  let s = sessions.get(docId)
  if (!s) {
    s = { messages: [], busy: false, error: null }
    sessions.set(docId, s)
  }
  return s
}

function setSession(docId: string, next: AiSession): void {
  sessions.set(docId, next)
  emit()
}

export function patchSession(docId: string, patch: Partial<Omit<AiSession, 'messages'>>): void {
  setSession(docId, { ...getSession(docId), ...patch })
}

export function appendMessage(docId: string, msg: ChatMessage): void {
  const s = getSession(docId)
  setSession(docId, { ...s, messages: [...s.messages, msg] })
}

export function clearSession(docId: string): void {
  setSession(docId, { messages: [], busy: false, error: null })
}
