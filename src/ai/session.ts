/**
 * AI 会话 store（批次1「统一对话」的地基）：按 doc.id 键的模块级 Map，
 * 编辑器五个 tab 条件渲染切走即卸载——会话必须跨卸载存活（与 ScriptTab drafts 同款先例）。
 * 消息结构沿用 client.ts 的 OpenAI 兼容 ChatMessage（含 tool 角色），
 * 面板经 subscribe + useSyncExternalStore 订阅更新。
 */

import type { ChatMessage } from './client'
import type { PlanState } from './plan'

export type { ChatMessage } from './client'
export type { PlanState, PlanItem, PlanItemStatus } from './plan'

export type AiMode = 'ask' | 'plan' | 'agent'

export interface AiSession {
  /** 完整多轮消息（user/assistant/tool），不含 system——system 每次请求现组装 */
  messages: ChatMessage[]
  /** agent 循环进行中：面板据此禁用发送、显示停止按钮 */
  busy: boolean
  /** 最近一次错误的可读文案；null = 无错误 */
  error: string | null
  /** 助手模式（ask=只读诊断 / plan=产出计划 / agent=可写工具直接修改）；按关卡记忆 */
  mode: AiMode
  /** agent 模式检查点时间戳（ms）；非空 = 面板显示「↩ 回滚」 */
  checkpointAt: number | null
  /** plan-act 工作流的计划（draft=待确认 / executing=逐项执行中 / done=完成）；null = 无计划 */
  plan: PlanState | null
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
    s = { messages: [], busy: false, error: null, mode: 'ask', checkpointAt: null, plan: null }
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

// ---------------------------------------------------------------------------
// 流式更新（批次6a）：delta 高频到达，按 40ms 合帧 commit，防面板逐 token 重渲染
// ---------------------------------------------------------------------------

const pendingDelta = new Map<string, string>()
let lastFlushAt = 0

function replaceLast(docId: string, patch: Partial<ChatMessage>): void {
  const s = getSession(docId)
  if (s.messages.length === 0) return
  const messages = [...s.messages]
  messages[messages.length - 1] = { ...messages[messages.length - 1], ...patch }
  setSession(docId, { ...s, messages })
}

/** 追加一条流式中的空 assistant 消息（streaming 标记 → 面板渲染光标） */
export function beginStreamingMessage(docId: string): void {
  appendMessage(docId, { role: 'assistant', content: '', streaming: true })
}

/** 流式追加 delta 到最后一条 assistant 消息（40ms 合帧）；finalize=true 立即刷出全部缓冲 */
export function streamAppendToLast(docId: string, delta: string, finalize = false): void {
  pendingDelta.set(docId, (pendingDelta.get(docId) ?? '') + delta)
  const flushNow = finalize || Date.now() - lastFlushAt >= 40
  const pending = pendingDelta.get(docId) ?? ''
  if (pending === '') return
  if (!flushNow) return
  lastFlushAt = Date.now()
  pendingDelta.delete(docId)
  const s = getSession(docId)
  const last = s.messages.at(-1)
  if (last?.role !== 'assistant' || last.streaming !== true) return
  replaceLast(docId, { content: last.content + pending })
}

/** 流式定稿：用最终消息替换流式占位（吞掉未刷缓冲，清除 streaming 标记） */
export function replaceLastMessage(docId: string, msg: ChatMessage): void {
  pendingDelta.delete(docId)
  const s = getSession(docId)
  if (s.messages.length === 0) return
  const messages = [...s.messages]
  messages[messages.length - 1] = msg
  setSession(docId, { ...s, messages })
}

export function clearSession(docId: string): void {
  setSession(docId, { messages: [], busy: false, error: null, mode: 'ask', checkpointAt: null, plan: null })
}
