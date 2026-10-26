/**
 * v4 会话内核（docs/53 §10）：把 Flow main、题型行为函数、组件 store、题单/牌堆、
 * 四层作用域、shell/surface 事件路由、绑定投影、计时器、watchdog 与调试钩子粘合为一个
 * 可被 React 播放层/无头 harness 驱动的主体。
 *
 * 边界：
 * - 本模块不做 DOM 渲染：对外暴露 `getSnapshot()` + `subscribe()`、`shellStore` 与
 *   `getSurfaceStore()`，播放层据此渲染（shell 常驻、surface 整帧挂载/卸载）；
 * - 不直接读文档以外的全局状态（音频副作用经 host.runEffects 转发）；
 * - 文档假设已通过 `loadLevelDocV4`（schema+validate+lint）。
 */
import { DATA_APPLY_COMMANDS, type ComponentInstance } from '../../engine/level'
import type { Json } from '../../engine/expr'
import { BehaviorRunner, type BehaviorHost, type BehaviorOutcome } from '../../engine/v4/behavior'
import { FlowRunner, type FlowHost, type FlowOutcome } from '../../engine/v4/flow'
import {
  CancelToken,
  CancelledError,
  sleepWithCancel,
} from '../../engine/v4/interpreter'
import { buildDeck, type DeckBuild } from '../../engine/v4/manifest'
import {
  cloneJson,
  getRow,
  getTable,
  getType,
  type ComponentInstanceV4,
  type DeckItem,
  type LevelDocV4,
  type QuestionResult,
  type QuestionTypeDef,
  type RunResult,
} from '../../engine/v4/model'
import {
  BEHAVIOR_ROOTS,
  FLOW_ROOTS,
  SHELL_BINDING_ROOTS,
  SURFACE_BINDING_ROOTS,
  evalV4,
  writeEnvPath,
} from '../../engine/v4/expr'
import type { Effect } from '../componentDef'
import { ComponentStore } from '../store'

// ---------------------------------------------------------------------------
// 对外类型（docs/53 §10）
// ---------------------------------------------------------------------------

export interface V4Budgets {
  flowNodeSteps: number
  behaviorNodeSteps: number
  exprSteps: number
  maxTasks: number
  maxEvents: number
  watchdogMs: number
}

const DEFAULT_BUDGETS: V4Budgets = {
  flowNodeSteps: 10_000,
  behaviorNodeSteps: 2_000,
  exprSteps: 1_000,
  maxTasks: 64,
  maxEvents: 256,
  watchdogMs: 120_000,
}

export interface TimerApi {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export interface V4RunEvent {
  kind: 'error' | 'warning' | 'flow' | 'behavior' | 'finish' | 'restart' | 'unsettled'
  message?: string
  nodeId?: string
  callId?: number
  t: number
}

export interface V4SessionHost {
  onFinished(result: RunResult): void
  runEffects(effects: Effect[], origin: { layer: 'shell' | 'surface'; componentId: string; callId?: number }): void
  getNowSeconds?(): number
  onRunEvent?(event: V4RunEvent): void
  debug?: {
    gate(kind: 'flow' | 'behavior', nodeId: string, ctx: { callId?: number; event?: string }): Promise<void>
  }
  budgets?: Partial<V4Budgets>
  timer?: TimerApi
  /** 随机源（牌堆 seed；调试/测试可注入） */
  random?: () => number
}

export interface V4Snapshot {
  version: number
  view: string
  shell: ComponentInstanceV4[]
  surface: { callId: number; typeId: string; components: ComponentInstanceV4[] } | null
  progress: { index: number; total: number }
  result: RunResult | null
  running: boolean
}

export interface V4DebugState {
  callStack: { kind: 'flow' | 'behavior'; nodeId: string; callId?: number; typeId?: string; rowId?: string }[]
  scopes: {
    v: Record<string, Json>
    local: Record<string, Json>
    t: Record<string, Json>
    q: Json | null
    qState: Json | null
    args: Json | null
    run: Record<string, Json>
  }
  deck: DeckItem[]
  result: RunResult | null
  logs: V4RunEvent[]
}

/** 每题返回记录（无头 harness / 调试器/测试用） */
export interface V4QuestionLogEntry {
  callId: number
  typeId: string
  rowId: string
  result: QuestionResult
}

// ---------------------------------------------------------------------------
// 内部结构
// ---------------------------------------------------------------------------

type TimerOwner = { layer: 'shell' } | { layer: 'surface'; callId: number }

interface TimerRecord {
  key: string
  owner: TimerOwner
  componentId: string
  handle: unknown
  ms: number
  repeat: boolean
  startedAt: number
  count: number
}

interface PausedTimerRecord {
  owner: TimerOwner
  componentId: string
  ms: number
  repeat: boolean
  remaining: number
}

interface BindingLayer {
  store: ComponentStore
  specs: ComponentInstanceV4[]
  applied: Map<string, string>
  failed: Set<string>
}

interface SurfaceFrame {
  callId: number
  typeId: string
  rowId: string
  type: QuestionTypeDef
  store: ComponentStore
  layer: BindingLayer
  qState: Record<string, Json>
  t: Record<string, Json>
  args: Record<string, Json>
  locals: Record<string, Json>
  qContent: Record<string, Json>
  cancel: CancelToken
  timerKeys: Set<string>
  behavior: BehaviorRunner | null
  watchdogTimer: unknown
  timeoutFired: boolean
}

interface ShellWaiter {
  event: string
  resolve: () => void
  reject: (err: Error) => void
  off: () => void
}

function isObjectJson(value: unknown): value is Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function initStateObject(fields: { key: string; init: Json }[] | undefined): Record<string, Json> {
  const out: Record<string, Json> = {}
  for (const field of fields ?? []) out[field.key] = cloneJson(field.init)
  return out
}

function argTypeMatches(value: Json, type: 'number' | 'boolean' | 'string' | 'json'): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return typeof value === 'string'
    case 'json':
      return true
  }
}

function questionKey(typeId: string, rowId: string): string {
  return `${typeId}:${rowId}`
}

const DEFAULT_TIMER_API: TimerApi = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

// ---------------------------------------------------------------------------
// V4Session
// ---------------------------------------------------------------------------

export class V4Session {
  readonly shellStore = new ComponentStore()

  private readonly host: V4SessionHost
  private readonly budgets: V4Budgets
  private readonly timerApi: TimerApi

  private readonly listeners = new Set<() => void>()
  private snapshot: V4Snapshot
  private snapshotVersion = 0
  private view: string
  private started = false
  private running = false
  private disposed = false

  private vars: Record<string, Json> = {}
  private flowLocals: Record<string, Json> = {}
  private typeStates = new Map<string, Record<string, Json>>()
  private questionStates = new Map<string, Record<string, Json>>()
  private runInfo: Record<string, Json> = { questions: [], total: 0, seed: 0, index: 0 }
  private deckBuild: DeckBuild = { deck: [], seed: 0, explicit: false }
  private progress = { index: 0, total: 0 }
  private result: RunResult | null = null
  private asksStarted = 0
  private callCounter = 0

  private shellLayer: BindingLayer
  private currentFrame: SurfaceFrame | null = null
  private runCancel: CancelToken | null = null
  private flowRunner: FlowRunner | null = null
  private pendingRestart = false

  private timers = new Map<string, TimerRecord>()
  private pausedTimers = new Map<string, PausedTimerRecord>()
  private timersPaused = false
  private shellWaiters: ShellWaiter[] = []
  private logs: V4RunEvent[] = []
  private questionLog: V4QuestionLogEntry[] = []

  constructor(doc: LevelDocV4, host: V4SessionHost) {
    this.doc = doc
    this.host = host
    this.budgets = { ...DEFAULT_BUDGETS, ...host.budgets }
    this.timerApi = host.timer ?? DEFAULT_TIMER_API
    this.view = doc.content.shell.initialView ?? doc.content.shell.views[0]?.id ?? 'main'
    this.resetRunState()
    this.shellStore.setEffectSink((componentId, effects) => this.handleEffects({ layer: 'shell' }, componentId, effects))
    this.shellLayer = this.mountLayer(this.shellStore, doc.content.shell.components, this.flowBindingEnv(), SHELL_BINDING_ROOTS)
    this.snapshot = this.buildSnapshot()
  }

  private readonly doc: LevelDocV4

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.running = true
    this.deckBuild = buildDeck(this.doc, { random: this.host.random })
    this.runInfo = {
      questions: this.deckBuild.deck as unknown as Json,
      total: this.deckBuild.deck.length,
      seed: this.deckBuild.seed,
      index: 0,
    }
    this.progress = { index: 0, total: this.deckBuild.deck.length }
    this.mountShell()
    this.notify()
    void this.runFlowLoop()
  }

  restart(): void {
    if (this.disposed || !this.started) return
    if (!this.running) {
      // 流程已结束（结算后静止）：直接重置并重新启动
      this.resetForRestart()
      this.running = true
      this.notify()
      void this.runFlowLoop()
      return
    }
    this.pendingRestart = true
    this.cancelActive()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.running = false
    this.cancelActive()
    this.stopAllTimers()
    this.listeners.clear()
  }

  private cancelActive(): void {
    this.runCancel?.cancel()
    this.runCancel = null
    const frame = this.currentFrame
    if (frame) {
      frame.cancel.cancel()
      this.currentFrame = null
      this.stopOwnerTimers({ layer: 'surface', callId: frame.callId })
    }
    this.rejectShellWaiters()
  }

  private async runFlowLoop(): Promise<void> {
    while (!this.disposed && this.running) {
      const cancel = new CancelToken()
      this.runCancel = cancel
      const runner = new FlowRunner(this.doc.content.flow, this.makeFlowHost(), {
        cancel,
        maxSteps: this.budgets.flowNodeSteps,
      })
      this.flowRunner = runner
      const outcome = await runner.run()
      if (this.disposed || !this.running) return
      if (this.pendingRestart) {
        this.pendingRestart = false
        this.resetForRestart()
        this.notify()
        continue
      }
      if (outcome.kind === 'restart') {
        this.resetForRestart()
        this.notify()
        continue
      }
      this.handleFlowOutcome(outcome)
      this.running = false
      this.rejectShellWaiters()
      this.notify()
      return
    }
  }

  private handleFlowOutcome(outcome: FlowOutcome): void {
    if (outcome.kind === 'end') {
      if (!outcome.settled) this.log('unsettled', '流程结束但未结算（未调用 finish）')
      return
    }
    if (outcome.kind === 'error') this.log('error', outcome.message)
    // aborted（dispose/restart 已处理，这里只记录）
    else if (outcome.kind === 'aborted') this.log('warning', '流程已中止')
  }

  private resetForRestart(): void {
    this.cancelActive()
    this.stopAllTimers()
    this.rejectShellWaiters()
    this.result = null
    this.asksStarted = 0
    this.callCounter = 0
    this.questionLog = []
    this.resetRunState()
    this.deckBuild = buildDeck(this.doc, { random: this.host.random })
    this.runInfo = {
      questions: this.deckBuild.deck as unknown as Json,
      total: this.deckBuild.deck.length,
      seed: this.deckBuild.seed,
      index: 0,
    }
    this.progress = { index: 0, total: this.deckBuild.deck.length }
    this.view = this.doc.content.shell.initialView ?? this.doc.content.shell.views[0]?.id ?? 'main'
    this.mountShell()
    this.log('restart', '关卡已重新开始')
  }

  private resetRunState(): void {
    this.vars = initStateObject(this.doc.content.flow.vars)
    this.flowLocals = {}
    this.typeStates = new Map()
    for (const type of this.doc.content.types) {
      this.typeStates.set(type.id, initStateObject(type.typeState))
    }
    this.questionStates = new Map()
    for (const type of this.doc.content.types) {
      const rows = this.doc.content.tables[type.id]?.rows ?? []
      for (const row of rows) {
        this.questionStates.set(questionKey(type.id, row.id), initStateObject(type.state))
      }
    }
  }

  private mountShell(): void {
    this.shellLayer = this.mountLayer(
      this.shellStore,
      this.doc.content.shell.components,
      this.flowBindingEnv(),
      SHELL_BINDING_ROOTS,
    )
  }

  // -------------------------------------------------------------------------
  // FlowHost
  // -------------------------------------------------------------------------

  private makeFlowHost(): FlowHost {
    const session = this
    return {
      evalExpr: (src) => this.evalFlow(src),
      writeTarget: (target, value) => this.writeFlowTarget(target, value),
      setLocal: (name, value) => {
        this.flowLocals[name] = value
      },
      readLocal: (name) => this.flowLocals[name] ?? null,
      command: (target, method, arg) => this.runComponentCommand('shell', this.shellStore, target, method, arg),
      query: (target, method, arg) => this.runComponentQuery(this.shellStore, target, method, arg),
      sleep: (ms) => this.sleepInRun(ms),
      ask: (target, args) => this.askQuestion(target, args),
      waitShell: (event) => this.waitShell(event),
      setView: (view) => this.setView(view),
      finish: (passed) => this.handleFinish(passed),
      gate: this.host.debug
        ? (node) => this.host.debug!.gate('flow', node.id, {})
        : undefined,
      log: (level, message, nodeId) => session.log(level === 'error' ? 'error' : 'warning', message, nodeId),
    }
  }

  private evalFlow(src: string): Json {
    return evalV4(src, this.flowBindingEnv(), FLOW_ROOTS, {
      stepBudget: this.budgets.exprSteps,
      getNowSeconds: this.host.getNowSeconds,
      questionState: (typeId, rowId, field) => this.readQuestionField(typeId, rowId, field, 'state'),
      questionContent: (typeId, rowId, field) => this.readQuestionField(typeId, rowId, field, 'content'),
    })
  }

  private flowBindingEnv(): Record<string, Json> {
    return { v: this.vars, local: this.flowLocals, run: this.runInfo }
  }

  private writeFlowTarget(target: string, value: Json): void {
    writeEnvPath(this.flowBindingEnv(), target, value)
    this.syncBindings()
  }

  private readQuestionField(typeId: string, rowId: string, field: string, from: 'state' | 'content'): Json {
    if (from === 'state') {
      const state = this.questionStates.get(questionKey(typeId, rowId))
      return state && Object.prototype.hasOwnProperty.call(state, field) ? state[field] : null
    }
    const row = getRow(this.doc, typeId, rowId)
    if (!row || !Object.prototype.hasOwnProperty.call(row, field)) return null
    const value = (row as unknown as Record<string, Json>)[field]
    return value === undefined ? null : value
  }

  private sleepInRun(ms: number): Promise<void> {
    const cancel = this.runCancel ?? new CancelToken()
    return sleepWithCancel(ms, cancel, this.timerApi)
  }

  private sleepInFrame(frame: SurfaceFrame, ms: number): Promise<void> {
    return sleepWithCancel(ms, frame.cancel, this.timerApi)
  }

  private setView(view: string): void {
    if (!this.doc.content.shell.views.some((candidate) => candidate.id === view)) {
      this.log('error', `setView 指向不存在的视图 "${view}"`)
      return
    }
    this.view = view
    this.notify()
  }

  private handleFinish(passed: boolean): void {
    if (this.result) {
      this.log('warning', 'finish 重复调用已忽略')
      return
    }
    const scoreValue = this.vars.score
    const score = typeof scoreValue === 'number' && Number.isFinite(scoreValue) ? scoreValue : 0
    this.result = { score, passed }
    this.log('finish', `结算：score=${score} passed=${passed}`)
    try {
      this.host.onFinished({ score, passed })
    } catch (err) {
      this.log('error', `onFinished 回调失败：${err instanceof Error ? err.message : String(err)}`)
    }
    this.notify()
  }

  // -------------------------------------------------------------------------
  // ask / 题型帧
  // -------------------------------------------------------------------------

  private resolveAskTarget(target: unknown): { type: string; row: string; args?: Json } | string {
    if (!isObjectJson(target)) return 'ask 的 target 必须是槽位对象 { type, row }'
    const type = target.type
    const row = target.row
    if (typeof type !== 'string' || typeof row !== 'string') return 'ask 的 target 缺少 type/row 字符串字段'
    const args = target.args
    if (args !== undefined && args !== null && !isObjectJson(args)) return 'ask 的 target.args 必须是对象或 null'
    return { type, row, args: args === undefined ? undefined : (args as Json) }
  }

  private mergeArgs(
    type: QuestionTypeDef,
    slotArgs: Json | undefined,
    callArgs: unknown,
  ): Record<string, Json> | string {
    const declared = new Map((type.args ?? []).map((field) => [field.key, field]))
    const merged: Record<string, Json> = {}
    for (const [key, field] of declared) {
      if (field.default !== undefined) merged[key] = cloneJson(field.default)
    }
    const apply = (source: unknown, layer: string): string | null => {
      if (source === undefined || source === null) return null
      if (!isObjectJson(source)) return `${layer} 参数必须是对象或 null`
      for (const [key, value] of Object.entries(source)) {
        const field = declared.get(key)
        if (!field) return `${layer} 参数 "${key}" 未在题型参数中声明`
        if (!argTypeMatches(value, field.type)) return `${layer} 参数 "${key}" 类型应为 ${field.type}`
        merged[key] = value
      }
      return null
    }
    const slotError = apply(slotArgs, 'target.args')
    if (slotError) return slotError
    const callError = apply(callArgs, 'args')
    if (callError) return callError
    for (const [key, field] of declared) {
      if (!field.optional && merged[key] === undefined) merged[key] = null
    }
    return merged
  }

  private askQuestion(target: unknown, args: unknown): Promise<QuestionResult> {
    return this.runQuestion(target, args)
  }

  private async runQuestion(target: unknown, args: unknown): Promise<QuestionResult> {
    const resolved = this.resolveAskTarget(target)
    if (typeof resolved === 'string') return { status: 'error', message: resolved }
    const type = getType(this.doc, resolved.type)
    const table = getTable(this.doc, resolved.type)
    const row = getRow(this.doc, resolved.type, resolved.row)
    if (!type || !table || !row) {
      return { status: 'error', message: `ask 目标不存在：题型 "${resolved.type}" 行 "${resolved.row}"` }
    }
    const mergedArgs = this.mergeArgs(type, resolved.args, args)
    if (typeof mergedArgs === 'string') return { status: 'error', message: mergedArgs }

    const callId = ++this.callCounter
    this.asksStarted += 1
    this.progress = { index: this.asksStarted, total: this.deckBuild.deck.length }
    this.runInfo = { ...this.runInfo, index: this.asksStarted }
    if (!this.questionStates.has(questionKey(type.id, row.id))) {
      this.questionStates.set(questionKey(type.id, row.id), initStateObject(type.state))
    }
    const frame = this.mountSurface(callId, type, row, mergedArgs)
    this.currentFrame = frame
    this.notify()
    const outcome = await this.runFrameBehavior(frame, type)
    this.endFrame(frame)
    this.notify()
    const questionResult = this.mapOutcome(outcome, frame)
    this.questionLog.push({ callId, typeId: type.id, rowId: row.id, result: questionResult })
    return questionResult
  }

  private mountSurface(
    callId: number,
    type: QuestionTypeDef,
    row: { id: string; [k: string]: Json | undefined },
    args: Record<string, Json>,
  ): SurfaceFrame {
    const store = new ComponentStore()
    const qState = this.questionStates.get(questionKey(type.id, row.id)) as Record<string, Json>
    const t = this.typeStates.get(type.id) as Record<string, Json>
    const qContent: Record<string, Json> = {}
    for (const [key, value] of Object.entries(row)) {
      if (key === 'id' || key === 'draft' || key === 'phase' || key === 'order') continue
      if (value !== undefined) qContent[key] = value
    }
    qContent.id = row.id
    const frame: SurfaceFrame = {
      callId,
      typeId: type.id,
      rowId: row.id,
      type,
      store,
      layer: { store, specs: [], applied: new Map(), failed: new Set() },
      qState,
      t,
      args,
      // docs/53 §7：behavior.locals 声明在每次调用开始时按初值初始化（Round 8 修复；
      // 此前为空对象，读取未写过的 local.* 会「未知属性」，样例不得不在 on start 手写初始化）
      locals: initStateObject(type.behavior.locals),
      qContent,
      cancel: new CancelToken(),
      timerKeys: new Set(),
      behavior: null,
      watchdogTimer: undefined,
      timeoutFired: false,
    }
    store.setEffectSink((componentId, effects) =>
      this.handleEffects({ layer: 'surface', callId }, componentId, effects),
    )
    frame.layer = this.mountLayer(store, type.surface.components, this.surfaceBindingEnv(frame), SURFACE_BINDING_ROOTS)
    return frame
  }

  private surfaceBindingEnv(frame: SurfaceFrame): Record<string, Json> {
    return {
      q: { ...frame.qContent, state: frame.qState },
      t: frame.t,
      args: frame.args,
      v: this.vars,
      run: this.runInfo,
    }
  }

  private behaviorEnv(frame: SurfaceFrame): Record<string, Json> {
    return {
      q: { ...frame.qContent, state: frame.qState },
      t: frame.t,
      local: frame.locals,
      args: frame.args,
      v: this.vars,
      run: this.runInfo,
    }
  }

  private runFrameBehavior(frame: SurfaceFrame, type: QuestionTypeDef): Promise<BehaviorOutcome> {
    const host: BehaviorHost = {
      evalExprForEvent: (src, event) =>
        evalV4(src, { ...this.behaviorEnv(frame), event }, BEHAVIOR_ROOTS, {
          stepBudget: this.budgets.exprSteps,
          getNowSeconds: this.host.getNowSeconds,
        }),
      evalExpr: (src) => host.evalExprForEvent(src, null),
      writeTarget: (target, value) => {
        writeEnvPath(
          { q: { state: frame.qState } as unknown as Json, t: frame.t, local: frame.locals },
          target,
          value,
        )
        this.syncBindings()
      },
      setLocal: (name, value) => {
        frame.locals[name] = value
      },
      readLocal: (name) => frame.locals[name] ?? null,
      command: (target, method, arg) => this.runComponentCommand('surface', frame.store, target, method, arg),
      query: (target, method, arg) => this.runComponentQuery(frame.store, target, method, arg),
      sleep: (ms) => this.sleepInFrame(frame, ms),
      gate: this.host.debug
        ? (node) => this.host.debug!.gate('behavior', node.id, { callId: frame.callId })
        : undefined,
      log: (level, message, nodeId) =>
        this.log(level === 'error' ? 'error' : 'warning', message, nodeId),
    }
    const runner = new BehaviorRunner(type.behavior, host, {
      cancel: frame.cancel,
      maxSteps: this.budgets.behaviorNodeSteps,
      maxTasks: this.budgets.maxTasks,
      maxEvents: this.budgets.maxEvents,
    })
    frame.behavior = runner
    const behaviorPromise = runner.run()
    const watchdogPromise = new Promise<BehaviorOutcome>((resolve) => {
      frame.watchdogTimer = this.timerApi.setTimeout(() => {
        frame.timeoutFired = true
        frame.cancel.cancel()
        resolve({ kind: 'aborted' })
      }, this.budgets.watchdogMs)
    })
    behaviorPromise.catch(() => {
      // run() 自身不会 reject（内部归一），防御性处理
    })
    return Promise.race([behaviorPromise, watchdogPromise]).finally(() => {
      this.timerApi.clearTimeout(frame.watchdogTimer)
    })
  }

  private mapOutcome(outcome: BehaviorOutcome, frame: SurfaceFrame): QuestionResult {
    if (outcome.kind === 'return') return outcome.result
    if (outcome.kind === 'error') return outcome.result
    return frame.timeoutFired
      ? { status: 'timeout', message: `题目超时（${this.budgets.watchdogMs}ms）` }
      : { status: 'aborted', message: '题目已中止' }
  }

  private endFrame(frame: SurfaceFrame): void {
    this.stopOwnerTimers({ layer: 'surface', callId: frame.callId })
    frame.cancel.cancel()
    if (this.currentFrame === frame) this.currentFrame = null
  }

  // -------------------------------------------------------------------------
  // 组件命令/查询 + 事件路由
  // -------------------------------------------------------------------------

  private runComponentCommand(
    layer: 'shell' | 'surface',
    store: ComponentStore,
    target: string,
    method: string,
    arg: Json,
  ): void {
    try {
      store.applyCommand(target, method, isObjectJson(arg) ? arg : {})
    } catch (err) {
      this.log(
        'error',
        `${layer} 组件命令失败 ${target}.${method}：${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private runComponentQuery(store: ComponentStore, target: string, method: string, arg: Json | undefined): Json {
    try {
      return store.query(target, method, arg === undefined ? [] : [arg])
    } catch (err) {
      this.log('error', `组件查询失败 ${target}.${method}：${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  }

  dispatchShellEvent(componentId: string, event: string, payload: Json = {}): void {
    void payload
    if (this.disposed) return
    const full = `${componentId}.${event}`
    if (this.currentFrame) {
      this.log('warning', `题目执行期间忽略 shell 事件 "${full}"`, undefined)
      return
    }
    const waiters = this.shellWaiters.filter((waiter) => waiter.event === full)
    if (waiters.length === 0) return
    for (const waiter of waiters) {
      this.removeWaiter(waiter)
      waiter.resolve()
    }
  }

  dispatchSurfaceEvent(localId: string, event: string, payload: Json = {}): void {
    const frame = this.currentFrame
    if (!frame || !frame.behavior) return
    if (!frame.layer.specs.some((spec) => spec.id === localId)) {
      this.log('warning', `surface 组件事件来自不存在的本地组件 "${localId}"`, undefined)
      return
    }
    frame.behavior.dispatch(`${localId}.${event}`, payload)
  }

  private waitShell(event: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.disposed || !this.running) {
        reject(new Error('运行已结束，无法等待 shell 事件'))
        return
      }
      const cancel = this.runCancel
      if (!cancel) {
        reject(new Error('流程未在运行'))
        return
      }
      const waiter: ShellWaiter = {
        event,
        resolve,
        reject,
        off: () => {},
      }
      waiter.off = cancel.onCancel(() => {
        this.removeWaiter(waiter)
        reject(new CancelledError())
      })
      this.shellWaiters.push(waiter)
    })
  }

  private removeWaiter(waiter: ShellWaiter): void {
    waiter.off()
    const index = this.shellWaiters.indexOf(waiter)
    if (index >= 0) this.shellWaiters.splice(index, 1)
  }

  private rejectShellWaiters(): void {
    for (const waiter of this.shellWaiters) {
      waiter.off()
      waiter.reject(new CancelledError())
    }
    this.shellWaiters = []
  }

  // -------------------------------------------------------------------------
  // 绑定
  // -------------------------------------------------------------------------

  private syncBindings(): void {
    this.applyBindings(this.shellLayer, this.flowBindingEnv(), SHELL_BINDING_ROOTS)
    const frame = this.currentFrame
    if (frame) this.applyBindings(frame.layer, this.surfaceBindingEnv(frame), SURFACE_BINDING_ROOTS)
  }

  private applyBindings(layer: BindingLayer, env: Record<string, Json>, roots: readonly string[]): void {
    for (const spec of layer.specs) {
      if (!spec.bindings) continue
      for (const [slot, expr] of Object.entries(spec.bindings)) {
        const key = `${spec.id}\u0000${slot}`
        let value: Json
        try {
          value = evalV4(expr, env, roots, { stepBudget: this.budgets.exprSteps })
        } catch (err) {
          if (!layer.failed.has(key)) {
            layer.failed.add(key)
            this.log(
              'warning',
              `绑定求值失败 ${spec.id}.${slot}：${err instanceof Error ? err.message : String(err)}`,
            )
          }
          continue
        }
        const hash = JSON.stringify(value)
        if (layer.applied.get(key) === hash) continue
        layer.applied.set(key, hash)
        const mapping = DATA_APPLY_COMMANDS[spec.type]?.[slot]
        if (!mapping) continue
        try {
          layer.store.applyCommand(spec.id, mapping.method, { [mapping.argKey]: value })
        } catch (err) {
          this.log(
            'warning',
            `绑定应用失败 ${spec.id}.${slot}：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
  }

  /**
   * 挂载层：先求值绑定合并进 props 再 store.init；记录初值避免挂载后再下发同一命令。
   *
   * 注意（Round 7 补丁）：并非所有组件 initialState 都消费 props（choice.options / staff.music
   * 由命令 setOptions/setMusic 写入），所以 init 后必须把绑定初值按 DATA_APPLY_COMMANDS 补发一次
   * 命令，否则这些槽位永远空白（applied 已记录初值，后续 syncBindings 不会补发）。
   */
  private mountLayer(
    store: ComponentStore,
    specs: ComponentInstanceV4[],
    env: Record<string, Json>,
    roots: readonly string[],
  ): BindingLayer {
    const applied = new Map<string, string>()
    const failed = new Set<string>()
    const merged = specs.map((spec) => {
      if (!spec.bindings) return spec
      const props: Record<string, Json> = isObjectJson(spec.props) ? { ...spec.props } : {}
      for (const [slot, expr] of Object.entries(spec.bindings)) {
        const key = `${spec.id}\u0000${slot}`
        try {
          const value = evalV4(expr, env, roots, { stepBudget: this.budgets.exprSteps })
          applied.set(key, JSON.stringify(value))
          const mapping = DATA_APPLY_COMMANDS[spec.type]?.[slot]
          if (mapping) props[mapping.argKey] = value
        } catch (err) {
          failed.add(key)
          this.log(
            'warning',
            `绑定求值失败 ${spec.id}.${slot}：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      return { ...spec, props: props as Json }
    })
    store.init(merged as ComponentInstance[])
    // 初值命令补发（见方法注释）：props 消费型组件重复设置无副作用，命令型组件依赖此步。
    for (const spec of merged) {
      if (!spec.bindings) continue
      const props = isObjectJson(spec.props) ? spec.props : {}
      for (const slot of Object.keys(spec.bindings)) {
        const mapping = DATA_APPLY_COMMANDS[spec.type]?.[slot]
        if (!mapping) continue
        const value = props[mapping.argKey]
        if (value === undefined) continue
        try {
          store.applyCommand(spec.id, mapping.method, { [mapping.argKey]: value })
        } catch (err) {
          this.log(
            'warning',
            `绑定初值应用失败 ${spec.id}.${slot}：${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
    return { store, specs: merged, applied, failed }
  }

  // -------------------------------------------------------------------------
  // 计时器（组件效果）
  // -------------------------------------------------------------------------

  private handleEffects(owner: TimerOwner, componentId: string, effects: Effect[]): void {
    for (const effect of effects) {
      if (effect.type === 'timer.start') this.startTimer(owner, componentId, effect.ms, effect.repeat)
      else if (effect.type === 'timer.stop') this.stopTimer(owner, componentId)
      else if (effect.type !== 'none') {
        this.host.runEffects([effect], {
          layer: owner.layer,
          componentId,
          ...(owner.layer === 'surface' ? { callId: owner.callId } : {}),
        })
      }
    }
  }

  private ownerStore(owner: TimerOwner): ComponentStore | null {
    if (owner.layer === 'shell') return this.shellStore
    const frame = this.currentFrame
    return frame && frame.callId === owner.callId ? frame.store : null
  }

  private timerKey(owner: TimerOwner, componentId: string): string {
    return owner.layer === 'shell' ? `shell:${componentId}` : `surface:${owner.callId}:${componentId}`
  }

  private startTimer(owner: TimerOwner, componentId: string, ms: number, repeat: boolean): void {
    this.stopTimer(owner, componentId)
    const key = this.timerKey(owner, componentId)
    const record: TimerRecord = {
      key,
      owner,
      componentId,
      handle: undefined,
      ms,
      repeat,
      startedAt: Date.now(),
      count: 0,
    }
    const fire = (): void => {
      record.count += 1
      try {
        this.ownerStore(owner)?.applyCommand(componentId, '__tick', { count: record.count })
      } catch (err) {
        this.log('warning', `计时器状态更新失败 ${componentId}：${err instanceof Error ? err.message : String(err)}`)
      }
      this.onTimerTick(owner, componentId, { count: record.count })
    }
    record.handle = repeat
      ? this.timerApi.setInterval(fire, Math.max(1, ms))
      : this.timerApi.setTimeout(fire, Math.max(1, ms))
    this.timers.set(key, record)
    if (owner.layer === 'surface') {
      const frame = this.currentFrame
      if (frame && frame.callId === owner.callId) frame.timerKeys.add(key)
    }
  }

  private stopTimer(owner: TimerOwner, componentId: string): void {
    const key = this.timerKey(owner, componentId)
    const record = this.timers.get(key)
    if (!record) return
    if (record.repeat) this.timerApi.clearInterval(record.handle)
    else this.timerApi.clearTimeout(record.handle)
    this.timers.delete(key)
  }

  private stopOwnerTimers(owner: TimerOwner): void {
    for (const [key, record] of [...this.timers]) {
      if (record.owner.layer !== owner.layer) continue
      if (owner.layer === 'surface' && record.owner.layer === 'surface' && record.owner.callId !== owner.callId) {
        continue
      }
      if (record.repeat) this.timerApi.clearInterval(record.handle)
      else this.timerApi.clearTimeout(record.handle)
      this.timers.delete(key)
    }
  }

  private stopAllTimers(): void {
    for (const record of this.timers.values()) {
      if (record.repeat) this.timerApi.clearInterval(record.handle)
      else this.timerApi.clearTimeout(record.handle)
    }
    this.timers.clear()
    this.pausedTimers.clear()
  }

  private onTimerTick(owner: TimerOwner, componentId: string, payload: Json): void {
    if (owner.layer === 'surface') {
      const frame = this.currentFrame
      if (frame && frame.callId === owner.callId) {
        frame.behavior?.dispatch(`${componentId}.tick`, payload)
      }
      return
    }
    // shell 计时器 tick 作为 shell 事件投递（题目执行期间忽略）
    this.dispatchShellEvent(componentId, 'tick', payload)
  }

  setTimersPaused(paused: boolean): void {
    if (paused === this.timersPaused) return
    this.timersPaused = paused
    if (paused) {
      for (const [key, record] of this.timers) {
        if (record.repeat) this.timerApi.clearInterval(record.handle)
        else this.timerApi.clearTimeout(record.handle)
        const remaining = Math.max(0, record.ms - (Date.now() - record.startedAt))
        this.pausedTimers.set(key, {
          owner: record.owner,
          componentId: record.componentId,
          ms: record.ms,
          repeat: record.repeat,
          remaining,
        })
      }
      this.timers.clear()
    } else {
      for (const [key, pausedRecord] of this.pausedTimers) {
        this.pausedTimers.delete(key)
        this.startTimer(
          pausedRecord.owner,
          pausedRecord.componentId,
          pausedRecord.repeat ? pausedRecord.ms : Math.max(1, pausedRecord.remaining),
          pausedRecord.repeat,
        )
      }
    }
  }

  // -------------------------------------------------------------------------
  // 快照 / 订阅 / 调试 / 日志
  // -------------------------------------------------------------------------

  getSnapshot(): V4Snapshot {
    return this.snapshot
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSurfaceStore(): ComponentStore | null {
    return this.currentFrame?.store ?? null
  }

  private buildSnapshot(): V4Snapshot {
    this.snapshotVersion += 1
    return {
      version: this.snapshotVersion,
      view: this.view,
      shell: this.shellLayer.specs,
      surface: this.currentFrame
        ? {
            callId: this.currentFrame.callId,
            typeId: this.currentFrame.typeId,
            components: this.currentFrame.layer.specs,
          }
        : null,
      progress: { ...this.progress },
      result: this.result,
      running: this.running,
    }
  }

  private notify(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of [...this.listeners]) listener()
  }

  getDebugState(): V4DebugState {
    const frame = this.currentFrame
    const q = frame ? ({ ...frame.qContent, state: frame.qState } as Json) : null
    const callStack: V4DebugState['callStack'] = [{ kind: 'flow', nodeId: this.flowRunner ? 'flow' : 'idle' }]
    if (frame) {
      callStack.push({
        kind: 'behavior',
        nodeId: frame.rowId,
        callId: frame.callId,
        typeId: frame.typeId,
        rowId: frame.rowId,
      })
    }
    return {
      callStack,
      scopes: {
        v: this.vars,
        local: frame ? frame.locals : this.flowLocals,
        t: frame ? frame.t : {},
        q,
        qState: frame ? (frame.qState as Json) : null,
        args: frame ? (frame.args as Json) : null,
        run: this.runInfo,
      },
      deck: this.deckBuild.deck,
      result: this.result,
      logs: [...this.logs],
    }
  }

  get deck(): DeckItem[] {
    return this.deckBuild.deck
  }

  get seed(): number {
    return this.deckBuild.seed
  }

  /** 每题返回记录（harness/调试器） */
  get questionResults(): readonly V4QuestionLogEntry[] {
    return this.questionLog
  }

  /** 当前正在等待的 shell 事件（harness 判断「流程是否停在 waitShell」） */
  get waitingShellEvents(): string[] {
    return this.shellWaiters.map((waiter) => waiter.event)
  }

  get isRunning(): boolean {
    return this.running
  }

  private log(kind: V4RunEvent['kind'], message: string, nodeId?: string): void {
    const event: V4RunEvent = { kind, message, ...(nodeId ? { nodeId } : {}), t: Date.now() }
    this.logs.push(event)
    if (this.logs.length > 200) this.logs.shift()
    this.host.onRunEvent?.(event)
  }
}
