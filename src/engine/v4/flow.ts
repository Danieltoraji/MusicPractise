/**
 * v4 Flow main 执行器（docs/53 §6）：关卡调度层。
 *
 * 职责：从 start 线性执行；`ask` 挂起等待题型函数返回；`finish` 记录结算（幂等）后
 * 流程可继续（只允许 shell 命令/setView/waitShell/wait/restart/comment）；`restart` 以
 * `RestartRequested` 抛出，由 V4Session 统一重置后重新执行；自然结束且未 finish = 未结算。
 *
 * 作用域/命令/查询/休眠由 FlowHost 注入（V4Session 提供真实实现；测试可注入桩）。
 */
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
  type StepResult,
  type WalkFrame,
} from './interpreter'
import type { Json } from '../expr'
import type { FlowNode, FlowProgram, QuestionResult } from './model'

/** restart 节点抛出的信号：V4Session 捕获后做「取消当前 run → 重置 → 重新 start」 */
export class RestartRequested extends Error {
  constructor() {
    super('流程请求重新开始')
    this.name = 'RestartRequested'
  }
}

export interface FlowHost extends SharedEnv {
  /** 调用题型函数：target = 牌堆槽位对象或 {type,row,args?}；args = 合并参数（可为 undefined） */
  ask(target: unknown, args: unknown): Promise<QuestionResult>
  /** 等待 shell 组件事件（`<compId>.<event>`），仅在题目执行之外 */
  waitShell(event: string): Promise<void>
  /** 切换 shell 视图 */
  setView(view: string): void
  /** 记录结算（score 由 session 从 v.score 读取；passed 由流程表达式给出） */
  finish(passed: boolean): void
  /** 调试断点闸门（可选；每节点执行前 await） */
  gate?(node: FlowNode): Promise<void>
  /** 运行日志（错误/警告由 session 汇总） */
  log(level: 'error' | 'warning', message: string, nodeId?: string): void
}

export type FlowOutcome =
  | { kind: 'end'; settled: boolean }
  | { kind: 'restart' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string }

/** finish 之后仍允许的节点（docs/53 §6；其余节点运行时报错；finish 自身幂等允许重复） */
const FINISH_AFTER_ALLOWED = new Set(['finish', 'call', 'setView', 'waitShell', 'wait', 'restart', 'comment'])

export interface FlowRunnerOptions {
  cancel: CancelToken
  /** 单次 run 的节点步数预算（默认 10000） */
  maxSteps?: number
}

export class FlowRunner {
  private readonly index: GraphIndex<FlowNode>
  private readonly frame: WalkFrame = { loopState: new Map() }
  private settled = false

  constructor(
    readonly program: FlowProgram,
    private readonly host: FlowHost,
    private readonly options: FlowRunnerOptions,
  ) {
    this.index = new GraphIndex(program)
  }

  /** 是否已结算（供 session 判断 ask-after-finish） */
  get isSettled(): boolean {
    return this.settled
  }

  async run(): Promise<FlowOutcome> {
    const start = this.program.nodes.find((node) => node.kind === 'start')
    if (!start) {
      this.host.log('error', '流程缺少 start 节点，无法启动')
      return { kind: 'error', message: '流程缺少 start 节点' }
    }
    const budget = new StepBudget(this.options.maxSteps ?? 10_000)
    try {
      await runChain({
        entry: start.id,
        index: this.index,
        cancel: this.options.cancel,
        budget,
        exec: (node) => this.execNode(node),
      })
    } catch (err) {
      if (err instanceof RestartRequested) return { kind: 'restart' }
      if (err instanceof CancelledError) return { kind: 'aborted' }
      if (err instanceof BudgetExceededError) {
        this.host.log('error', err.message)
        return { kind: 'error', message: err.message }
      }
      const message = err instanceof Error ? err.message : String(err)
      this.host.log('error', `流程执行失败：${message}`)
      return { kind: 'error', message }
    }
    if (!this.settled) {
      this.host.log('warning', '流程自然结束但未调用 finish：本局未结算')
      return { kind: 'end', settled: false }
    }
    return { kind: 'end', settled: true }
  }

  private async execNode(node: FlowNode): Promise<StepResult | void> {
    await this.host.gate?.(node)
    if (this.settled && !FINISH_AFTER_ALLOWED.has(node.kind)) {
      throw new FlowRuntimeError(
        `finish 之后不能执行 ${node.kind} 节点「${node.id}」（只允许 shell 命令/setView/waitShell/wait/restart/comment）`,
      )
    }
    const shared = await execSharedNode(node, this.frame, this.host, this.options.cancel)
    if (shared !== null) return shared
    switch (node.kind) {
      case 'start':
        return {}
      case 'ask': {
        const target = this.host.evalExpr(node.target)
        const args = node.args !== undefined ? this.host.evalExpr(node.args) : undefined
        const result = await this.host.ask(target, args)
        this.options.cancel.throwIfCancelled()
        this.host.setLocal(node.resultVar, result as unknown as Json)
        return {}
      }
      case 'waitShell':
        await this.host.waitShell(node.event)
        this.options.cancel.throwIfCancelled()
        return {}
      case 'setView':
        this.host.setView(node.view)
        return {}
      case 'finish': {
        if (this.settled) {
          this.host.log('warning', `finish 重复调用已忽略（节点「${node.id}」）`, node.id)
          return {}
        }
        const passed = node.passed !== undefined ? Boolean(this.host.evalExpr(node.passed)) : true
        this.settled = true
        this.host.finish(passed)
        return {}
      }
      case 'restart':
        throw new RestartRequested()
      default: {
        const kind = (node as { kind?: string }).kind
        throw new FlowRuntimeError(`未知流程节点类型 "${String(kind)}"`)
      }
    }
  }
}

/** 便捷函数：构造 runner 并执行（session 通常自行持有实例；测试/无头可直接用） */
export async function runFlow(
  program: FlowProgram,
  host: FlowHost,
  options: FlowRunnerOptions,
): Promise<FlowOutcome> {
  return new FlowRunner(program, host, options).run()
}
