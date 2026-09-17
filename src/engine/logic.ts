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
  private baseRules: Rule[]
  private byEvent: Map<string, Rule[]>
  private initialVars: Record<string, Json>

  constructor(program: LogicProgram, host: LogicHost) {
    this.host = host
    this.baseRules = program.rules
    this.initialVars = structuredClone(program.variables ?? {})
    this.vars = structuredClone(this.initialVars)
    this.byEvent = this.indexRules(this.baseRules)
  }

  private indexRules(rules: Rule[]): Map<string, Rule[]> {
    const map = new Map<string, Rule[]>()
    for (const rule of rules) {
      const list = map.get(rule.on) ?? []
      list.push(rule)
      map.set(rule.on, list)
    }
    return map
  }

  /**
   * 替换动态规则集（题目 logicPatch.appendRules 用）：
   * 以基础规则 + 追加规则重建索引，变量不受影响。
   */
  setDynamicRules(rules: Rule[]): void {
    this.byEvent = this.indexRules(rules)
  }

  /** 装载期校验上下文：提供组件 id 集合时可做悬空引用检查 */
  static lint(program: LogicProgram, ctx?: { componentIds?: Iterable<string> }): string[] {
    const errors: string[] = []
    const compIds = ctx?.componentIds ? new Set(ctx.componentIds) : null

    // 1) 表达式语法（解析期错误前置）
    const checkSyntax = (src: string, where: string) => {
      try {
        evalExpr(src, { event: {}, q: null, v: {} })
      } catch (e) {
        if (e instanceof Error && /未闭合|无法识别|期望|意外|多余内容|嵌套过深|过长/.test(e.message)) {
          errors.push(`${where}: ${e.message}`)
        }
      }
    }

    // 2) on/cmd 的组件引用存在性（内部事件 名字:名字 与 level 伪组件除外）
    const checkCompRef = (cid: string, where: string) => {
      if (!compIds || cid === 'level' || cid.includes(':')) return
      if (!compIds.has(cid)) errors.push(`${where}: 引用不存在的组件 "${cid}"`)
    }

    for (const rule of program.rules) {
      if (!rule.on.includes(':')) checkCompRef(rule.on.split('.')[0], `规则 ${rule.id} on`)
      rule.when?.forEach((w, i) => checkSyntax(w, `规则 ${rule.id} when[${i}]`))
      const isSetAction = (a: Action): a is Extract<Action, { set: string }> => 'set' in a
      for (const [phase, list] of [
        ['do', rule.do],
        ['else', rule.else ?? []],
      ] as const) {
        list.forEach((a, i) => {
          const where = `规则 ${rule.id} ${phase}[${i}]`
          if ('expr' in a) {
            checkSyntax(a.expr, where)
          } else if ('cmd' in a) {
            checkCompRef(a.cmd.split('.')[0], where)
          } else if (isSetAction(a)) {
            if (program.variables && !(a.set in program.variables)) {
              errors.push(`${where}: set 未声明变量 "${a.set}"（请在 variables 中声明）`)
            }
          }
        })
      }
    }

    // 3) emit 触发图环检测（规则 A 发事件点亮规则 B、B 又发事件回到 A）
    const byEvent = new Map<string, Rule[]>()
    for (const rule of program.rules) {
      const list = byEvent.get(rule.on) ?? []
      list.push(rule)
      byEvent.set(rule.on, list)
    }
    const emitTargets = (rule: Rule): string[] =>
      [...rule.do, ...(rule.else ?? [])].filter((a): a is Extract<Action, { emit: string }> => 'emit' in a).map((a) => a.emit)
    const state = new Map<string, 1 | 2>()
    const visit = (rule: Rule): void => {
      state.set(rule.id, 1)
      for (const ev of emitTargets(rule)) {
        for (const next of byEvent.get(ev) ?? []) {
          if (state.get(next.id) === 1) {
            errors.push(`规则触发环: ${rule.id} → ${next.id}（运行时会被级联预算拦截，应修正逻辑）`)
          } else if (!state.has(next.id)) {
            visit(next)
          }
        }
      }
      state.set(rule.id, 2)
    }
    for (const rule of program.rules) if (!state.has(rule.id)) visit(rule)

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

  /** 深度解析动作参数中的 "$q.…"/"$event.…"/"$v.…"/"$expr:…" 引用；其余字符串（含 "$100"）一律字面量 */
  resolve(value: Json, ctx?: DispatchCtx): Json {
    const scope: ExprScope = ctx?.scope ?? { event: {}, q: this.host.getQuestion(), v: this.vars }
    const ectx: ExprContext = ctx?.ctx ?? { getNowSeconds: this.host.getNowSeconds }
    const refRe = /^\$(q|event|v)(\.[A-Za-z_]\w*)+$/
    const walk = (v: Json): Json => {
      if (typeof v === 'string') {
        if (v.startsWith('$expr:')) return evalExpr(v.slice(6), scope, ectx)
        if (refRe.test(v)) return evalExpr(v.slice(1), scope, ectx)
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
    // 原地清空再回填，保持 vars 对象身份不变：
    // 级联中途 restart 时，同批后续 set 动作仍持有 dispatch 捕获的旧引用，
    // 若整体替换对象会造成"读旧写新"的状态错乱
    for (const key of Object.keys(this.vars)) delete this.vars[key]
    Object.assign(this.vars, structuredClone(this.initialVars))
  }

  private fail(err: unknown, context: { ruleId?: string; event?: string }): void {
    if (this.host.onError) this.host.onError(err, context)
    else console.error('[logic]', context, err)
  }
}
