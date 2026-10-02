/**
 * 编辑器调试运行管理器（docs/30）：Debug 模式的核心。
 * 在编辑器内以当前文档开一个带调试门控的 LevelSession——断点/单步/暂停在节点边界挂起，
 * 变量实时观察与赋值（直写 engine.vars，不触发逻辑——是观察/强设工具）、
 * 实时运行日志（onLogicEvent 推送）、手动触发事件（session.dispatch，与 UI 点击同路径）。
 * 仅存在于编辑器工作台：Debug 模式只在编辑器开启（需求边界），游玩页不受影响。
 * 模块级单例 + 可订阅快照（与会话 store 同款惯例）。
 */

import type { LevelDoc } from '../../engine/level'
import type { Json } from '../../engine/expr'
import type { LogicRunEvent, SessionHost } from '../../runtime/levelSession'
import { LevelSession } from '../../runtime/levelSession'
import { loadLevelDoc } from '../../library/validate'

export type DebugMode = 'idle' | 'running' | 'paused'

export interface DebugSnapshot {
  mode: DebugMode
  /** 暂停所在的节点 id（mode==='paused' 时非空） */
  pausedAt: string | null
  pausedEvent: string | null
  breakpoints: string[]
  /** 实时运行日志（最新在末尾，上限 100 条） */
  events: LogicRunEvent[]
  /** 变量实时值（engine.vars 快照） */
  vars: Record<string, Json>
  view: string
  row: number
  total: number
  finished: { score: Json; passed: boolean } | null
  /** 启动失败原因（装载被拒） */
  loadErrors: string[] | null
}

// ---------------------------------------------------------------------------
// 门控控制器：断点/单步/手动暂停 → 引擎在节点边界挂起
// ---------------------------------------------------------------------------

const controller = {
  enabled: false,
  breakpoints: new Set<string>(),
  pendingPause: false,
  pendingStep: false,
  resolvers: [] as Array<() => void>,
  pausedAt: null as string | null,
  pausedEvent: null as string | null,
}

const debugHost = {
  gate(nodeId: string, event: string): Promise<void> {
    if (!controller.enabled) return Promise.resolve()
    if (!controller.pendingPause && !controller.pendingStep && !controller.breakpoints.has(nodeId)) {
      return Promise.resolve()
    }
    controller.pendingStep = false
    controller.pendingPause = false
    controller.pausedAt = nodeId
    controller.pausedEvent = event
    commit({ mode: 'paused', pausedAt: nodeId, pausedEvent: event })
    return new Promise<void>((resolve) => {
      controller.resolvers.push(() => {
        controller.pausedAt = null
        controller.pausedEvent = null
        commit({ mode: session ? 'running' : 'idle', pausedAt: null, pausedEvent: null })
        resolve()
      })
    })
  },
}

function releaseAll(): void {
  releaseAllSilently()
  notify()
}

function releaseAllSilently(): void {
  controller.pausedAt = null
  controller.pausedEvent = null
  const rs = controller.resolvers.splice(0)
  for (const r of rs) r()
}

// ---------------------------------------------------------------------------
// 快照 store
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>()
let snapshot: DebugSnapshot = {
  mode: 'idle',
  pausedAt: null,
  pausedEvent: null,
  breakpoints: [],
  events: [],
  vars: {},
  view: '',
  row: 0,
  total: 0,
  finished: null,
  loadErrors: null,
}

function notify(): void {
  for (const fn of listeners) fn()
}

function commit(patch: Partial<DebugSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  notify()
}

export function subscribeDebugRun(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getDebugSnapshot(): DebugSnapshot {
  return snapshot
}

// ---------------------------------------------------------------------------
// 会话生命周期
// ---------------------------------------------------------------------------

let session: LevelSession | null = null
let refreshTimer: ReturnType<typeof setInterval> | null = null
let docIdRef: string | null = null

const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** 从运行中的会话刷新实时状态（变量/视图/行/结算） */
function refreshLive(): void {
  if (!session) return
  commit({
    vars: { ...session.engine.vars } as Record<string, Json>,
    view: session.currentView,
    row: session.index,
    total: session.total,
  })
}

export function isDebuggingDoc(docId: string): boolean {
  return snapshot.mode !== 'idle' && docIdRef === docId
}

/** 启动调试会话；返回 null = 成功，否则为装载错误文本 */
export async function startDebugRun(doc: LevelDoc): Promise<string | null> {
  if (session) stopDebugRun()
  const check = loadLevelDoc(structuredClone(doc))
  if (!check.ok) {
    commit({ mode: 'idle', loadErrors: check.errors })
    return check.errors.join('；')
  }
  docIdRef = doc.id
  commit({ mode: 'running', events: [], finished: null, loadErrors: null, pausedAt: null, pausedEvent: null })

  const host: SessionHost = {
    onRow: (index, total) => {
      commit({ row: index, total })
    },
    onView: (id) => {
      commit({ view: id })
    },
    onFinished: (r) => {
      commit({ finished: r })
    },
    runEffects: () => {
      // 调试运行不播放音频/不驱动真实组件：效果只被丢弃（变量与日志照常）
    },
    onLogicEvent: (e) => {
      const events = [...snapshot.events, e].slice(-100)
      commit({ events })
    },
    budgets: { maxEvents: 64, maxNodes: 512 },
    debug: debugHost,
  }
  controller.enabled = true
  session = new LevelSession(check.doc, host)
  session.start()
  await flush()
  refreshLive()
  notify()
  // 实时观察：运行期间低频刷新变量快照（wait/timer 推进的状态）
  refreshTimer = setInterval(() => {
    if (controller.pausedAt === null) refreshLive()
  }, 400)
  return null
}

export function stopDebugRun(): void {
  controller.enabled = false
  releaseAllSilently()
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  session?.dispose()
  session = null
  docIdRef = null
  commit({ mode: 'idle', pausedAt: null, pausedEvent: null })
}

/** 继续：放行当前挂起的节点，跑到下一个断点 */
export function resumeDebug(): void {
  releaseAll()
}

/** 单步：放行当前节点，在下一个节点边界重新暂停 */
export function stepDebug(): void {
  controller.pendingStep = true
  releaseAll()
}

/** 暂停：在下一个节点边界挂起（无法打断正在 await 的 wait） */
export function pauseDebug(): void {
  if (session) controller.pendingPause = true
}

/** 手动触发组件事件（与 UI 点击同路径）；返回错误文本或 null */
export async function dispatchDebugEvent(event: string, payload: Json = {}): Promise<string | null> {
  if (!session) return '调试会话未运行——先启动调试'
  if (!event.trim()) return '事件名不能为空'
  session.dispatch(event.trim(), payload)
  await flush()
  refreshLive()
  notify()
  return null
}

/** 变量实时赋值：直写引擎变量（观察/强设工具，不触发逻辑） */
export function setDebugVar(name: string, value: Json): string | null {
  if (!session) return '调试会话未运行'
  if (name.startsWith('__')) return `${name} 是系统变量，不可赋值`
  session.engine.vars[name] = value
  refreshLive()
  return null
}

export function toggleDebugBreakpoint(nodeId: string): void {
  if (controller.breakpoints.has(nodeId)) controller.breakpoints.delete(nodeId)
  else controller.breakpoints.add(nodeId)
  commit({ breakpoints: [...controller.breakpoints] })
}

export function clearDebugBreakpoints(): void {
  controller.breakpoints.clear()
  commit({ breakpoints: [] })
}
