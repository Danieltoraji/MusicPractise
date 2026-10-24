/**
 * AI 会话 store（批次1「统一对话」的地基）：按 doc.id 键的模块级 Map，
 * 编辑器五个 tab 条件渲染切走即卸载——会话必须跨卸载存活（与 ScriptTab drafts 同款先例）。
 * 消息结构沿用 client.ts 的 OpenAI 兼容 ChatMessage（含 tool 角色），
 * 面板经 subscribe + useSyncExternalStore 订阅更新。
 */

import type { ChatMessage, ChatUsage } from './client'
import type { PlanItem, PlanState } from './plan'
import type { AiSessionRecord } from '../library/db'

export type { ChatMessage, ChatUsage } from './client'
export type { PlanState, PlanItem, PlanItemStatus } from './plan'

export type AiMode = 'ask' | 'plan' | 'agent'

/**
 * F10（docs/44 R19）：AI 会话持久化记录版本。
 * 结构校验/未来版本拒绝见 sanitizePersistedSession——损坏/升级前记录不得直接注入会话。
 */
export const AI_SESSION_SCHEMA_VERSION = 1
/** 持久化消息上限（防 IndexedDB 无限膨胀；最近的消息优先保留） */
const MAX_PERSISTED_MESSAGES = 400
/** 单条消息字符上限（图片 data URL 另计） */
const MAX_PERSISTED_CHARS = 200_000

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
  /** 本会话累计 token 用量（供应商返回才计入；批次8c） */
  usage?: ChatUsage
  /** 当前运行已完成的请求轮数（运行时态不持久；每次 runAgentTurn 开始归零） */
  turnCount?: number
  /** 上次运行撞到轮数上限未跑完（运行时态不持久；面板据此显示「▶ 继续」续跑条） */
  turnCapHit?: boolean
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
  schedulePersist(docId) // 批次6b：防抖写入 IndexedDB
}

export function patchSession(docId: string, patch: Partial<Omit<AiSession, 'messages'>>): void {
  setSession(docId, { ...getSession(docId), ...patch })
}

export function appendMessage(docId: string, msg: ChatMessage): void {
  const s = getSession(docId)
  setSession(docId, { ...s, messages: [...s.messages, msg] })
}

/** 累计本会话 token 用量（供应商未返回 usage 时不产生变更；批次8c） */
export function addSessionUsage(docId: string, usage: ChatUsage | undefined): void {
  if (!usage) return
  const cur = getSession(docId).usage ?? { promptTokens: 0, completionTokens: 0 }
  patchSession(docId, {
    usage: {
      promptTokens: cur.promptTokens + usage.promptTokens,
      completionTokens: cur.completionTokens + usage.completionTokens,
    },
  })
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

/**
 * 流式中断/失败收尾（docs/40 F2）：末条若为 streaming 占位——空则整体移除，
 * 已有半截内容则定稿（清 streaming 标记并加中断注记）；同时清未刷 delta。
 * 不调用时：中止/网络错误会留下永久闪烁的幽灵占位，重试会把它发给严格供应商（4xx），
 * 残留 pendingDelta 还会把旧尾巴拼进下一轮首帧。
 */
export function finalizeStreamingMessage(docId: string): void {
  pendingDelta.delete(docId)
  const s = getSession(docId)
  const last = s.messages.at(-1)
  if (!last || last.role !== 'assistant' || last.streaming !== true) return
  if (last.content.trim() === '') {
    setSession(docId, { ...s, messages: s.messages.slice(0, -1) })
    return
  }
  const messages = [...s.messages]
  messages[messages.length - 1] = { ...last, streaming: undefined, content: `${last.content}（已中断）` }
  setSession(docId, { ...s, messages })
}

/** 持久化/下发前清洗：streaming 占位不是合法消息（docs/40 F2——旧档里可能残留） */
function withoutStreamingGhost(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => m.streaming !== true)
}

// ---------------------------------------------------------------------------
// F10（docs/44 R19）：持久化记录结构校验/清洗。
// 此前 hydrate 直接 `rec.messages as ChatMessage[]`——库内坏记录（手改/旧版本/半写）
// 会以非法消息进入会话，渲染或下次请求才炸。现在：逐条校验角色/内容/工具调用/图片，
// 剔除 streaming 幽灵与未知字段；未来版本记录拒绝载入（保护新版本数据不被旧代码改写）。
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function clipText(v: unknown, max = MAX_PERSISTED_CHARS): string {
  return typeof v === 'string' ? v.slice(0, max) : ''
}

function sanitizeToolCalls(v: unknown): ChatMessage['toolCalls'] {
  if (!Array.isArray(v)) return undefined
  const out = []
  for (const raw of v) {
    const o = asRecord(raw)
    const fn = o ? asRecord(o.function) : null
    if (!o || !fn || typeof o.id !== 'string' || o.type !== 'function' || typeof fn.name !== 'string') continue
    if (typeof fn.arguments !== 'string') continue
    out.push({ id: clipText(o.id, 200), type: 'function' as const, function: { name: clipText(fn.name, 200), arguments: clipText(fn.arguments) } })
  }
  return out.length > 0 ? out : undefined
}

function sanitizeMessage(raw: unknown): ChatMessage | null {
  const o = asRecord(raw)
  if (!o) return null
  const role = o.role
  if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') return null
  const content = clipText(o.content)
  const toolCalls = sanitizeToolCalls(o.toolCalls)
  // 空 assistant（无文本也无 tool_calls）= 流式残影；tool 消息必须有 toolCallId
  if (role === 'assistant' && content === '' && !toolCalls) return null
  if (role === 'tool' && typeof o.toolCallId !== 'string') return null
  const images = Array.isArray(o.images)
    ? o.images.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 12)
    : []
  const msg: ChatMessage = { role, content }
  if (toolCalls) msg.toolCalls = toolCalls
  if (typeof o.toolCallId === 'string') msg.toolCallId = clipText(o.toolCallId, 200)
  if (typeof o.name === 'string') msg.name = clipText(o.name, 200)
  if (images.length > 0) msg.images = images
  // streaming 字段一律不保留（持久化记录只存定稿消息）
  return msg
}

function sanitizePlan(v: unknown): PlanState | null {
  const o = asRecord(v)
  if (!o || !Array.isArray(o.items)) return null
  const status = o.status
  if (status !== 'draft' && status !== 'executing' && status !== 'done') return null
  const items = o.items.flatMap((raw): PlanItem[] => {
    const it = asRecord(raw)
    if (!it || typeof it.text !== 'string') return []
    const itemStatus = it.status
    const status: PlanItem['status'] =
      itemStatus === 'in_progress' || itemStatus === 'done' || itemStatus === 'skipped' ? itemStatus : 'pending'
    return [{ text: clipText(it.text, 2000), status, enabled: it.enabled !== false }]
  })
  return { raw: clipText(o.raw, 20_000), status, items }
}

function sanitizeUsage(v: unknown): ChatUsage | undefined {
  const o = asRecord(v)
  if (!o) return undefined
  const promptTokens = typeof o.promptTokens === 'number' && Number.isFinite(o.promptTokens) ? Math.max(0, o.promptTokens) : 0
  const completionTokens =
    typeof o.completionTokens === 'number' && Number.isFinite(o.completionTokens) ? Math.max(0, o.completionTokens) : 0
  return { promptTokens, completionTokens }
}

/**
 * F10：把 IndexedDB 原始记录清洗为可安全注入会话的 `AiSessionRecord`；不可用时返回 null。
 * - docId 必须匹配（防串档）；未来 schemaVersion 拒绝（保护新数据）；
 * - messages 逐条校验（未知角色/空 assistant/缺 toolCallId 的 tool 丢弃），最多保留最近 400 条；
 * - plan/mode/usage 同样校验；旧记录无 schemaVersion 按 v0 兼容读取。
 */
export function sanitizePersistedSession(raw: unknown, docId: string): AiSessionRecord | null {
  const o = asRecord(raw)
  if (!o || o.docId !== docId) return null
  const version = o.schemaVersion
  if (typeof version === 'number' && version > AI_SESSION_SCHEMA_VERSION) return null
  const messages = Array.isArray(o.messages)
    ? o.messages
        .map(sanitizeMessage)
        .filter((m): m is ChatMessage => m !== null)
        .slice(-MAX_PERSISTED_MESSAGES)
    : []
  if (messages.length === 0) return null
  return {
    docId,
    schemaVersion: AI_SESSION_SCHEMA_VERSION,
    messages,
    plan: sanitizePlan(o.plan),
    mode: o.mode === 'agent' || o.mode === 'plan' ? o.mode : 'ask',
    usage: sanitizeUsage(o.usage),
    updatedAt: typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : Date.now(),
  }
}

export function clearSession(docId: string): void {
  setSession(docId, {
    messages: [],
    busy: false,
    error: null,
    mode: 'ask',
    checkpointAt: null,
    plan: null,
    usage: undefined,
    turnCount: undefined,
    turnCapHit: false,
  })
}

// ---------------------------------------------------------------------------
// 持久化（批次6b）：IndexedDB aiSessions 表（db v3），刷新/重开后恢复对话。
// setSession 时防抖写入（600ms）；busy/error/checkpointAt 为运行时态不持久。
// hydrateSession：内存为空时才载入（幂等）；恢复后 executing 计划可由面板继续执行。
// ---------------------------------------------------------------------------

import { db } from '../library/db'

const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
const hydrated = new Set<string>()

function schedulePersist(docId: string): void {
  const prev = persistTimers.get(docId)
  if (prev) clearTimeout(prev)
  persistTimers.set(
    docId,
    setTimeout(() => {
      persistTimers.delete(docId)
      const s = getSession(docId)
      if (s.messages.length === 0) {
        void db.aiSessions.delete(docId).catch(() => {})
        return
      }
      void db.aiSessions
        .put({
          docId,
          schemaVersion: AI_SESSION_SCHEMA_VERSION,
          messages: withoutStreamingGhost(s.messages),
          plan: s.plan,
          mode: s.mode,
          usage: s.usage,
          updatedAt: Date.now(),
        })
        .catch(() => {})
    }, 600),
  )
}

/**
 * 会话换档（docs/42 §4.6 C5）：内置示例另存副本后 doc.id 变更，按 docId 键控的会话状态
 * （内存消息/plan/mode/checkpointAt/usage + IndexedDB aiSessions 持久化记录）必须跟着迁移，
 * 否则同挂载内对话清空、刷新后历史也失联。
 *
 * 返回是否迁移了内存会话（调用方据此复位被中止 run 残留的 busy——见 EditorPage 内置副本分支）。
 * IndexedDB 迁移失败不抛错（内存会话照常；刷新后丢失与旧行为一致）。
 */
export async function renameSession(oldDocId: string, newDocId: string): Promise<boolean> {
  if (oldDocId === newDocId) return false
  const moved = sessions.get(oldDocId)
  if (moved) {
    sessions.delete(oldDocId)
    sessions.set(newDocId, moved)
  }
  const pending = pendingDelta.get(oldDocId)
  if (pending !== undefined) {
    pendingDelta.delete(oldDocId)
    pendingDelta.set(newDocId, pending)
  }
  // 旧 id 的防抖持久化任务作废（否则会把旧会话再次写回 IndexedDB）
  const timer = persistTimers.get(oldDocId)
  if (timer) {
    clearTimeout(timer)
    persistTimers.delete(oldDocId)
  }
  // 内存已有完整对话 = 新 id 已恢复，不必再从 IndexedDB 载入（hydrateSession 的空内存才载入语义）
  if (moved && moved.messages.length > 0) hydrated.add(newDocId)
  emit()
  try {
    const rec = await db.aiSessions.get(oldDocId)
    if (rec) {
      await db.aiSessions.put({ ...rec, docId: newDocId, schemaVersion: AI_SESSION_SCHEMA_VERSION })
      await db.aiSessions.delete(oldDocId)
    }
  } catch {
    // IndexedDB 不可用：内存会话照常可用
  }
  // 迁移后的内存会话落到新 id（防抖 600ms 自然覆盖；旧 id 记录已删/搬）
  if (moved && moved.messages.length > 0) schedulePersist(newDocId)
  return moved !== undefined
}

/** 恢复持久化会话（内存为空时才载入；幂等）。失败静默——空会话照常可用 */
export async function hydrateSession(docId: string): Promise<void> {
  const s = getSession(docId)
  if (s.messages.length > 0 || hydrated.has(docId)) return
  hydrated.add(docId)
  try {
    const raw = await db.aiSessions.get(docId)
    // F10（R19）：清洗 + 版本校验——坏记录/未来版本不注入会话（旧实现直接 cast）
    const rec = sanitizePersistedSession(raw, docId)
    if (!rec) return
    const cur = getSession(docId)
    if (cur.messages.length > 0) return // 挂载期间已有新消息（kickoff 等），不覆盖
    setSession(docId, {
      ...cur,
      messages: withoutStreamingGhost(rec.messages as ChatMessage[]),
      plan: rec.plan as PlanState | null,
      mode: rec.mode,
      usage: rec.usage ?? undefined,
    })
  } catch {
    // IndexedDB 不可用：空会话照常
  }
}
