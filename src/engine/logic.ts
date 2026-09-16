/**
 * 逻辑引擎：统一运行时语义 = 事件驱动的 ECA（事件→条件→动作）规则。
 * 节点图（二期）与脚本节点（三期）都编译/降级到这一层。
 *
 * 引擎不认识具体组件：命令通过 host.dispatchCommand 回调交给宿主（关卡运行器），
 * 这保证引擎可独立单测。
 */

import { evalExpr, type ExprContext, type ExprScope, type Json } from './expr'

export interface LogicProgram {
  variables?: Record<string, Json>
  rules: Rule[]
}

export interface Rule {
  id: string
  /** "组件id.事件名" 或内部事件 "名字:名字"，或生命周期事件 "level.started" 等 */
  on: string
  when?: string[]
  do: Action[]
  else?: Action[]
}

export type Action =
  | { cmd: string; args?: Json }
  | { set: string; expr: string }
  | { emit: string; payload?: Json }

export interface LogicHost {
  /** 当前题目对象（表达式作用域 q） */
  getQuestion(): Json | null
  /** 命令分发（组件id.命令 / level.next 等），由宿主实现 */
  dispatchCommand(path: string, args: Json): void
  getNowSeconds?: () => number
  onError?: (err: unknown, context: { ruleId?: string; event?: string }) => void
  budgets?: Budgets
}

export interface Budgets {
  /** 单表达式步数（默认 1000） */
  exprSteps?: number
  /** 单次 dispatch 最多处理的事件数（默认 64） */
  maxEvents?: number
  /** 单次 dispatch 最多执行的动作数（默认 512） */
  maxActions?: number
}

interface QueuedEvent {
  event: string
  payload: Json
}

interface DispatchCtx {
  scope: ExprScope
  ctx: ExprContext
  queue: QueuedEvent[]
  processed: number
  actionsRun: number
}

export class LogicEngine {
  vars: Record<string, Json>
  private host: LogicHost
  private byEvent: Map<string, Rule[]>
  private initialVars: Record<string, Json>

  constructor(program: LogicProgram, host: LogicHost) {
    this.host = host
    this.initialVars = structuredClone(program.variables ?? {})
    this.vars = structuredClone(this.initialVars)
    this.byEvent = new Map()
    for (const rule of program.rules) {
      const list = this.byEvent.get(rule.on) ?? []
      list.push(rule)
      this.byEvent.set(rule.on, list)
    }
  }

  /** 装载期校验：所有表达式可解析（提前暴露语法错误） */
  static lint(program: LogicProgram): string[] {
    const errors: string[] = []
    const check = (src: string, where: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        evalExpr(src, { event: {}, q: null, v: {} })
      } catch (e) {
        // 只区分语法错误（解析期）；求值期错误（未知属性等）留给运行时
        if (e instanceof Error && /未闭合|无法识别|期望|意外|多余内容|嵌套过深|过长/.test(e.message)) {
          errors.push(`${where}: ${e.message}`)
        }
      }
    }
    for (const rule of program.rules) {
      rule.when?.forEach((w, i) => check(w, `规则 ${rule.id} when[${i}]`))
      for (const [phase, list] of [['do', rule.do], ['else', rule.else ?? []]] as const) {
        list.forEach((a, i) => {
          const where = `规则 ${rule.id} ${phase}[${i}]`
          if ('expr' in a) check(a.expr, where)
        })
      }
    }
    return errors
  }

  /** 入口：派发事件。内部 emit 的事件在同一调用中级联处理，受预算约束。 */
  dispatch(event: string, payload: Json = {}): void {
    const b = this.host.budgets ?? {}
    const maxEvents = b.maxEvents ?? 64
    const ctx: DispatchCtx = {
      scope: { event: payload, q: this.host.getQuestion(), v: this.vars },
      ctx: { getNowSeconds: this.host.getNowSeconds, stepBudget: b.exprSteps ?? 1000 },
      queue: [{ event, payload }],
      processed: 0,
      actionsRun: 0,
    }
    while (ctx.queue.length > 0) {
      if (ctx.processed >= maxEvents) {
        this.fail(new Error(`事件级联超过预算（${maxEvents}）`), { event })
        return
      }
      const { event: ev, payload: pl } = ctx.queue.shift()!
      ctx.processed++
      ctx.scope.event = pl
      this.runRules(ev, ctx)
    }
  }

  private rulesFor(event: string): Rule[] {
    return this.byEvent.get(event) ?? []
  }

  private runRules(event: string, ctx: DispatchCtx): void {
    for (const rule of this.rulesFor(event)) {
      try {
        let pass = true
        for (const cond of rule.when ?? []) {
          if (!evalExpr(cond, ctx.scope, ctx.ctx)) {
            pass = false
            break
          }
        }
        const actions = pass ? rule.do : (rule.else ?? [])
        this.runActions(actions, rule.id, event, ctx)
      } catch (err) {
        this.fail(err, { ruleId: rule.id, event })
      }
    }
  }

  private runActions(actions: Action[], ruleId: string, event: string, ctx: DispatchCtx): void {
    for (const action of actions) {
      if (++ctx.actionsRun > (this.host.budgets?.maxActions ?? 512)) {
        this.fail(new Error('动作执行数超过预算'), { ruleId, event })
        return
      }
      if ('cmd' in action) {
        const args = action.args === undefined ? {} : this.resolve(action.args, ctx)
        this.host.dispatchCommand(action.cmd, args)
      } else if ('set' in action) {
        this.vars[action.set] = evalExpr(action.expr, ctx.scope, ctx.ctx)
      } else if ('emit' in action) {
        ctx.queue.push({ event: action.emit, payload: action.payload === undefined ? {} : this.resolve(action.payload, ctx) })
      }
    }
  }

  /** 深度解析动作参数中的 "$q.…"/"$event.…"/"$v.…"/"$expr:…" 引用 */
  resolve(value: Json, ctx?: DispatchCtx): Json {
    const scope: ExprScope = ctx?.scope ?? { event: {}, q: this.host.getQuestion(), v: this.vars }
    const ectx: ExprContext = ctx?.ctx ?? { getNowSeconds: this.host.getNowSeconds }
    const walk = (v: Json): Json => {
      if (typeof v === 'string') {
        if (v.startsWith('$expr:')) return evalExpr(v.slice(6), scope, ectx)
        if (v.startsWith('$')) return evalExpr(v.slice(1), scope, ectx)
        return v
      }
      if (Array.isArray(v)) return v.map(walk)
      if (v !== null && typeof v === 'object') {
        const out: Record<string, Json> = {}
        for (const [k, val] of Object.entries(v)) out[k] = walk(val)
        return out
      }
      return v
    }
    return walk(value)
  }

  /** 独立求值（如 flow.pass 通过线表达式）；作用域 event 默认为空对象 */
  evaluate(expr: string, event: Json = {}): Json {
    return evalExpr(expr, { event, q: this.host.getQuestion(), v: this.vars }, { getNowSeconds: this.host.getNowSeconds })
  }

  reset(): void {
    this.vars = structuredClone(this.initialVars)
  }

  private fail(err: unknown, context: { ruleId?: string; event?: string }): void {
    if (this.host.onError) this.host.onError(err, context)
    else console.error('[logic]', context, err)
  }
}
