/**
 * v4 题型行为执行器（docs/53 §7）：一道题的「异步函数」。
 *
 * 事件模型：
 * - `run()` 派发 `start`；`dispatch(event, payload)` 注入组件事件/计时器 tick；
 * - 每个匹配的 `on` 处理器创建一个独立异步任务（程序顺序），任务内顺序执行、
 *   任务间仅在 await 点（wait/emit 之后）交错；事件队列 FIFO，`emit` 入队后当前链继续；
 * - `return` 首个生效：归一化 QuestionResult、结束调用、取消其它任务与休眠；
 * - 节点错误 → `{kind:'error', result:{status:'error',message}}`；外部取消 → aborted；
 * - 预算：单次调用累计节点步数 / 并发任务数 / 事件数（超限 → error）。
 *
 * 作用域/命令/查询/休眠由 `BehaviorHost` 注入（session 提供真实实现；测试注入桩）。
 */
import type { Json } from '../expr'
import {
  BudgetExceededError,
  CancelToken,
  CancelledError,
  FlowRuntimeError,
  GraphIndex,
  StepBudget,
  execSharedNode,
  runChain,
  type SharedEnv,
  type WalkFrame,
} from './interpreter'
import {
  normalizeQuestionResult,
  type BehaviorNode,
  type BehaviorProgram,
  type EmitNode,
  type OnNode,
  type QuestionResult,
  type ReturnNode,
} from './model'

/** 内部：调用已结束后，迟到任务用异常退出走链 */
class StoppedError extends Error {
  constructor() {
    super('调用已结束')
    this.name = 'StoppedError'
  }
}

export interface BehaviorHost extends SharedEnv {
  /** 在 handler 的事件上下文中求值（event 根 = { name, payload }） */
  evalExprForEvent(src: string, event: Json): Json
  /** 切换本题题型内视图（v4.1；无题内视图或视图不存在时由宿主记运行日志） */
  setView(view: string): void
  gate?(node: BehaviorNode): Promise<void>
  log(level: 'error' | 'warning', message: string, nodeId?: string): void
}

export type BehaviorOutcome =
  | { kind: 'return'; result: QuestionResult }
  | { kind: 'error'; result: QuestionResult; message: string }
  | { kind: 'aborted' }

export interface BehaviorRunnerOptions {
  /** 外部取消令牌（session 的帧取消；watchdog 也通过它触发） */
  cancel: CancelToken
  maxSteps?: number
  maxTasks?: number
  maxEvents?: number
}

interface QueuedEvent {
  event: string
  payload: Json
}

export class BehaviorRunner {
  private readonly index: GraphIndex<BehaviorNode>
  private readonly budget: StepBudget
  private readonly maxTasks: number
  private readonly maxEvents: number
  private readonly cancel = new CancelToken()
  private readonly queue: QueuedEvent[] = []
  private readonly tasks = new Set<Promise<void>>()

  private scheduled = false
  private draining = false
  private finished = false
  private started = false
  private eventsProcessed = 0
  private offExternalCancel?: () => void
  private resolveOnce?: (outcome: BehaviorOutcome) => void

  constructor(
    readonly program: BehaviorProgram,
    private readonly host: BehaviorHost,
    private readonly options: BehaviorRunnerOptions,
  ) {
    this.index = new GraphIndex(program)
    this.budget = new StepBudget(options.maxSteps ?? 2_000)
    this.maxTasks = options.maxTasks ?? 64
    this.maxEvents = options.maxEvents ?? 256
  }

  /** 开始调用：派发 start，返回首个 return / error / aborted 的结果 */
  run(): Promise<BehaviorOutcome> {
    if (this.started) throw new FlowRuntimeError('BehaviorRunner 只能 run 一次')
    this.started = true
    return new Promise<BehaviorOutcome>((resolve) => {
      this.resolveOnce = resolve
      this.offExternalCancel = this.options.cancel.onCancel(() => this.finish({ kind: 'aborted' }))
      const handlers = this.handlersOf('start')
      if (handlers.length === 0) {
        this.finish({
          kind: 'error',
          result: { status: 'error', message: '行为图缺少 on start 处理器' },
          message: '行为图缺少 on start 处理器',
        })
        return
      }
      this.enqueue('start', {})
    })
  }

  /** 注入事件（组件事件/计时器 tick/内部事件）；调用结束后静默丢弃 */
  dispatch(event: string, payload: Json = {}): void {
    if (this.finished) return
    this.enqueue(event, payload)
  }

  get isFinished(): boolean {
    return this.finished
  }

  private handlersOf(event: string): OnNode[] {
    return this.program.nodes.filter((node): node is OnNode => node.kind === 'on' && node.event === event)
  }

  private enqueue(event: string, payload: Json): void {
    if (this.finished) return
    this.eventsProcessed += 1
    if (this.eventsProcessed > this.maxEvents) {
      const message = `事件数超过预算（${this.maxEvents}）`
      this.host.log('error', message)
      this.finish({ kind: 'error', result: { status: 'error', message }, message })
      return
    }
    this.queue.push({ event, payload })
    this.schedule()
  }

  private schedule(): void {
    if (this.scheduled || this.finished) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      void this.drain()
    })
  }

  /** 事件泵：逐个事件创建任务；任务异步交错（不 await），事件之间保持 FIFO */
  private async drain(): Promise<void> {
    if (this.draining || this.finished) return
    this.draining = true
    try {
      while (this.queue.length > 0 && !this.finished) {
        const queued = this.queue.shift() as QueuedEvent
        for (const handler of this.handlersOf(queued.event)) {
          if (this.finished) break
          this.spawn(handler, queued)
        }
      }
    } finally {
      this.draining = false
      if (!this.finished && this.queue.length > 0) this.schedule()
    }
  }

  private spawn(handler: OnNode, queued: QueuedEvent): void {
    if (this.tasks.size >= this.maxTasks) {
      const message = `并发任务数超过预算（${this.maxTasks}）`
      this.host.log('error', message, handler.id)
      this.finish({ kind: 'error', result: { status: 'error', message }, message })
      return
    }
    let task: Promise<void>
    task = this.runTask(handler, queued)
      .catch((err) => this.onTaskError(err))
      .finally(() => {
        this.tasks.delete(task)
      })
    this.tasks.add(task)
  }

  private makeTaskEnv(eventValue: Json): SharedEnv {
    const host = this.host
    return {
      evalExpr: (src) => host.evalExprForEvent(src, eventValue),
      writeTarget: (target, value) => host.writeTarget(target, value),
      setLocal: (name, value) => host.setLocal(name, value),
      readLocal: (name) => host.readLocal(name),
      command: (target, method, arg) => host.command(target, method, arg),
      query: (target, method, arg) => host.query(target, method, arg),
      sleep: (ms) => host.sleep(ms),
    }
  }

  private async runTask(handler: OnNode, queued: QueuedEvent): Promise<void> {
    const entry = this.index.next(handler.id)
    if (entry === null) return // handler 无后续节点：空处理器
    const eventValue: Json = { name: queued.event, payload: queued.payload }
    const env = this.makeTaskEnv(eventValue)
    // 每个任务独立 WalkFrame（v4.2）：repeat/foreach 的循环游标不跨并发任务共享；
    // 同一事件的多个任务（含 timer 重复触发）各自完整地遍历自己的数组。
    const frame: WalkFrame = { loopState: new Map() }
    await runChain({
      entry,
      index: this.index,
      cancel: this.cancel,
      budget: this.budget,
      exec: async (node) => {
        if (this.finished) throw new StoppedError()
        await this.host.gate?.(node)
        const shared = await execSharedNode(node, frame, env, this.cancel)
        if (shared !== null) return shared
        switch (node.kind) {
          case 'return': {
            const value = env.evalExpr((node as ReturnNode).result)
            const result = normalizeQuestionResult(value)
            this.finish({ kind: 'return', result })
            throw new StoppedError()
          }
          case 'emit': {
            const emit = node as EmitNode
            const payload: Record<string, Json> = {}
            for (const [key, source] of Object.entries(emit.payload ?? {})) {
              payload[key] = env.evalExpr(source)
            }
            this.enqueue(emit.event, payload)
            return {}
          }
          case 'setView':
            this.host.setView(node.view)
            return {}
          case 'on':
            throw new FlowRuntimeError(`on 节点「${node.id}」不能作为执行链成员`)
          default:
            throw new FlowRuntimeError(`未知行为节点类型 "${(node as BehaviorNode).kind}"`)
        }
      },
    })
  }

  private onTaskError(err: unknown): void {
    if (this.finished) return
    if (err instanceof StoppedError) return
    if (err instanceof CancelledError) {
      this.finish({ kind: 'aborted' })
      return
    }
    if (err instanceof BudgetExceededError) {
      this.host.log('error', err.message)
      this.finish({ kind: 'error', result: { status: 'error', message: err.message }, message: err.message })
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    this.host.log('error', `行为执行失败：${message}`)
    this.finish({ kind: 'error', result: { status: 'error', message }, message })
  }

  private finish(outcome: BehaviorOutcome): void {
    if (this.finished) return
    this.finished = true
    this.offExternalCancel?.()
    this.offExternalCancel = undefined
    this.cancel.cancel()
    this.queue.length = 0
    this.resolveOnce?.(outcome)
    this.resolveOnce = undefined
  }
}
