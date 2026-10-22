/**
 * 编辑器调试运行管理器（docs/30）：Debug 模式的核心。
 * 在编辑器内以当前文档开一个带调试门控的 LevelSession——断点/单步/暂停在节点边界挂起，
 * 变量实时观察与赋值（直写 engine.vars，不触发逻辑——是观察/强设工具）、
 * 实时运行日志（onLogicEvent 推送）、手动触发事件（session.dispatch，与 UI 点击同路径）。
 * 仅存在于编辑器工作台：Debug 模式只在编辑器开启（需求边界），游玩页不受影响。
 * 模块级单例 + 可订阅快照（与会话 store 同款惯例）。
 */

import type { LevelDoc, TableRow } from '../../engine/level'
import type { Json } from '../../engine/expr'
import type { LogicRunEvent, SessionHost } from '../../runtime/levelSession'
import { LevelSession } from '../../runtime/levelSession'
import type { ComponentStore } from '../../runtime/store'
import { runAudioEffects, nowSeconds } from '../../runtime/audioHost'
import { loadLevelDoc } from '../../library/validate'

export type DebugMode = 'idle' | 'running' | 'paused'

/** 调试画面的渲染源（批次9 可视化）：组件层用它把会话画出来——与真实游玩同构 */
export interface DebugStageSource {
  /** 装载管线产出的规范文档（会话实际运行的副本） */
  doc: LevelDoc
  /** 会话组件状态 store（per-session 实例） */
  store: ComponentStore
  /** 组件事件发射（点击 = session.dispatch，与手动触发同路径） */
  emitFor(id: string): (event: string, payload?: Json) => void
  /** 会话代数（每次 start 自增；React 据此重挂画面） */
  sessionNo: number
}

export interface DebugSnapshot {
  mode: DebugMode
  /** 会话归属（docs/40 E4）：human=面板启动 / ai=AI 工具启动——徽标显示 + 工具守卫依据 */
  owner: 'human' | 'ai' | null
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
  /** 当前题目行数据（画面顶条题面用） */
  rowData: TableRow | null
  finished: { score: Json; passed: boolean } | null
  /** 启动失败原因（装载被拒） */
  loadErrors: string[] | null
  /** 可见画面渲染源；null = 无运行中的会话 */
  stage: DebugStageSource | null
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
    // 挂起时冻结计时器（timer __tick 绕过门控直改组件状态——不冻结会出现画面已停倒计时还在跳）
    session?.setTimersPaused(true)
    commit({ mode: 'paused', pausedAt: nodeId, pausedEvent: event })
    return new Promise<void>((resolve) => {
      controller.resolvers.push(() => {
        controller.pausedAt = null
        controller.pausedEvent = null
        session?.setTimersPaused(false)
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
  owner: null,
  pausedAt: null,
  pausedEvent: null,
  breakpoints: [],
  events: [],
  vars: {},
  view: '',
  row: 0,
  total: 0,
  rowData: null,
  finished: null,
  loadErrors: null,
  stage: null,
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
let sessionNo = 0
// 启动代次（docs/40 E9）：startDebugRun 在 session.start() 后有 await 窗口——
// 窗口内 stopDebugRun 会把 session 置 null 并泄漏随后挂上的 interval 与仍在跑的实例。
// await 返回后代次不一致 = 已被 newer start/stop 接管，本次收尾退出。
let startGeneration = 0

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

/** 启动调试会话；返回 null = 成功，否则为装载错误文本。owner 标记会话归属（docs/40 E4） */
export async function startDebugRun(doc: LevelDoc, owner: 'human' | 'ai' = 'human'): Promise<string | null> {
  if (session) stopDebugRun()
  const check = loadLevelDoc(structuredClone(doc))
  if (!check.ok) {
    commit({ mode: 'idle', loadErrors: check.errors, stage: null })
    return check.errors.join('；')
  }
  const generation = ++startGeneration
  // E10（docs/40）：断点集与文档绑定——运行中切换到不同文档时清空（旧图的节点 id
  // 对新图无意义，残留断点永不命中还会误发光）；无会话时的预设备点与同关重开保留
  if (docIdRef !== null && docIdRef !== doc.id) {
    controller.breakpoints.clear()
  }
  docIdRef = doc.id
  sessionNo += 1
  commit({ mode: 'running', owner, events: [], finished: null, loadErrors: null, pausedAt: null, pausedEvent: null })

  const host: SessionHost = {
    onRow: (index, total, rowData) => {
      commit({ row: index, total, rowData: rowData ?? null })
    },
    onView: (id) => {
      commit({ view: id })
    },
    onFinished: (r) => {
      commit({ finished: r })
    },
    // 批次9 可视化：调试会话播放真实音频——「正常的游玩画面」应有听感
    runEffects: (effects) => runAudioEffects(effects),
    getNowSeconds: nowSeconds,
    onLogicEvent: (e) => {
      const events = [...snapshot.events, e].slice(-100)
      commit({ events })
    },
    budgets: { maxEvents: 64, maxNodes: 512 },
    debug: debugHost,
  }
  controller.enabled = true
  const inst = new LevelSession(check.doc, host)
  session = inst
  // 画面渲染源：组件层从快照读它画游玩画面（引用稳定，运行中 commit 不替换）
  const stage: DebugStageSource = {
    doc: check.doc,
    store: inst.store,
    emitFor: (id) => inst.emitFor(id),
    sessionNo,
  }
  commit({ stage })
  inst.start()
  await flush()
  if (generation !== startGeneration) {
    // await 窗口内已被 stop/新 start 接管：本次启动的实例必须就地销毁，否则
    // session 引用已被清/换，这个实例带着音频与计时器「隐形运行」（docs/40 C3/E9）
    inst.dispose()
    return null
  }
  refreshLive()
  notify()
  // 实时观察：运行期间低频刷新变量快照（wait/timer 推进的状态）
  refreshTimer = setInterval(() => {
    if (controller.pausedAt === null) refreshLive()
  }, 400)
  return null
}

export function stopDebugRun(): void {
  startGeneration += 1 // 作废在途启动（E9）
  controller.enabled = false
  controller.pendingPause = false // E7：残留标志跨会话——不清会让下次启动第一个节点就暂停
  controller.pendingStep = false
  releaseAllSilently()
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  session?.dispose()
  session = null
  docIdRef = null
  commit({ mode: 'idle', owner: null, pausedAt: null, pausedEvent: null, stage: null })
}

/** 重开当前调试会话（restart 语义：变量/组件/行复位重跑；断点与日志保留）。
 *  E8：先放行全部挂起门 + 清暂停/结算暂态——暂停中重开会卡在旧门、结算横幅残留 */
export function restartDebug(): string | null {
  if (!session) return '调试会话未运行'
  releaseAllSilently()
  controller.pendingPause = false
  controller.pendingStep = false
  commit({ finished: null, pausedAt: null, pausedEvent: null, mode: 'running' })
  session.restart()
  void Promise.resolve().then(async () => {
    await flush()
    refreshLive()
    notify()
  })
  return null
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

/** 全量替换断点集（AI debug_breakpoints 工具用） */
export function setDebugBreakpoints(ids: string[]): void {
  controller.breakpoints = new Set(ids)
  commit({ breakpoints: [...controller.breakpoints] })
}

export function clearDebugBreakpoints(): void {
  controller.breakpoints.clear()
  commit({ breakpoints: [] })
}
