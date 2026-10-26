/**
 * v4 编辑器调试运行（docs/52 W7.1）：包装 V4Session，提供节点边界断点/单步/继续/暂停计时器/
 * 调试快照订阅。运行归属遵守 docs/40 §12.4：编辑器持有 controller，切 Tab/卸载/切文档时 stop()。
 *
 * 与 AI/无头 harness 的区别：这是「可见游玩画面 + 调试器」的宿主，snapshot 里同时带
 * session 渲染快照（舞台/进度/结算）与调试状态（调用栈/四层作用域/牌堆/日志）。
 */
import type { LevelDocV4, RunResult } from '../../engine/v4/model'
import {
  V4Session,
  type V4DebugState,
  type V4RunEvent,
  type V4SessionHost,
  type V4Snapshot,
} from '../../runtime/v4/session'

export interface DebugBreakpoint {
  kind: 'flow' | 'behavior'
  nodeId: string
}

export interface V4DebugPausePoint extends DebugBreakpoint {
  event?: string
}

export interface V4DebugSnapshot {
  /** 调试状态：调用栈/作用域/牌堆/结果/日志 */
  state: V4DebugState
  /** 渲染快照：舞台/进度/结算（可见调试画面用） */
  session: V4Snapshot
  paused: boolean
  pausedAt: V4DebugPausePoint | null
  running: boolean
}

export interface V4DebugControllerOptions {
  onFinished?(result: RunResult): void
  onRunEvent?(event: V4RunEvent): void
  onUpdate?(snapshot: V4DebugSnapshot): void
}

/**
 * 调试运行控制器：
 * - gate 在每次节点执行前被 V4Session 调用；命中「断点」或用户「暂停」时挂起，step/resume 放行；
 * - step = 放行当前节点并在下一个节点再次暂停；resume = 继续到下一个断点；
 * - stop 会先放行挂起的 gate 再 dispose，避免会话永远卡在门控上（docs/40 已知坑）。
 */
export class V4DebugController {
  readonly session: V4Session

  private readonly opts: V4DebugControllerOptions
  private readonly breakpoints = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private paused = false
  private pauseNext = false
  private pausedAt: V4DebugPausePoint | null = null
  private gateResolve: (() => void) | null = null
  private stopped = false

  constructor(doc: LevelDocV4, opts: V4DebugControllerOptions = {}) {
    this.opts = opts
    const host: V4SessionHost = {
      onFinished: (result) => {
        opts.onFinished?.(result)
        this.notify()
      },
      runEffects: () => {
        // 编辑器调试画面不播声音（与 v3 DebugStage 口径一致）
      },
      onRunEvent: (event) => {
        opts.onRunEvent?.(event)
        this.notify()
      },
      debug: {
        gate: (kind, nodeId) => this.gate(kind, nodeId),
      },
    }
    this.session = new V4Session(doc, host)
  }

  start(): void {
    if (this.stopped) return
    this.session.start()
    this.notify()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.releaseGate()
    this.session.setTimersPaused(false)
    this.session.dispose()
    this.listeners.clear()
  }

  /** 整体替换断点集合（编辑器面板用） */
  setBreakpoints(points: DebugBreakpoint[]): void {
    this.breakpoints.clear()
    for (const point of points) this.breakpoints.add(this.key(point.kind, point.nodeId))
    this.notify()
  }

  toggleBreakpoint(kind: 'flow' | 'behavior', nodeId: string): boolean {
    const key = this.key(kind, nodeId)
    const has = this.breakpoints.has(key)
    if (has) this.breakpoints.delete(key)
    else this.breakpoints.add(key)
    this.notify()
    return !has
  }

  hasBreakpoint(kind: 'flow' | 'behavior', nodeId: string): boolean {
    return this.breakpoints.has(this.key(kind, nodeId))
  }

  /** 单步：放行当前暂停点，在下一个节点边界再次暂停 */
  step(): void {
    if (!this.paused) {
      this.pauseNext = true
      this.notify()
      return
    }
    this.pauseNext = true
    this.releaseGate()
  }

  /** 继续：放行直到下一个断点 */
  resume(): void {
    this.pauseNext = false
    this.releaseGate()
  }

  /** 暂停：当前节点执行完后在下一个节点边界停住（节点边界语义，不打断异步等待） */
  pause(): void {
    if (this.paused) return
    this.pauseNext = true
    this.notify()
  }

  setTimersPaused(paused: boolean): void {
    this.session.setTimersPaused(paused)
    this.notify()
  }

  getSnapshot(): V4DebugSnapshot {
    return {
      state: this.session.getDebugState(),
      session: this.session.getSnapshot(),
      paused: this.paused,
      pausedAt: this.pausedAt,
      running: this.session.isRunning,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private key(kind: 'flow' | 'behavior', nodeId: string): string {
    return `${kind}:${nodeId}`
  }

  private gate(kind: 'flow' | 'behavior', nodeId: string): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const shouldPause = this.pauseNext || this.breakpoints.has(this.key(kind, nodeId))
    if (!shouldPause) return Promise.resolve()
    this.pauseNext = false
    this.paused = true
    this.pausedAt = { kind, nodeId }
    this.notify()
    return new Promise<void>((resolve) => {
      this.gateResolve = () => {
        this.gateResolve = null
        this.paused = false
        this.pausedAt = null
        this.notify()
        resolve()
      }
    })
  }

  private releaseGate(): void {
    const resolve = this.gateResolve
    if (resolve) resolve()
  }

  private notify(): void {
    const snapshot = this.getSnapshot()
    this.opts.onUpdate?.(snapshot)
    for (const listener of [...this.listeners]) listener()
  }
}
