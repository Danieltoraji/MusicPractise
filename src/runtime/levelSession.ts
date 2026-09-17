/**
 * 关卡会话：与 React 无关的流程核心（装载题目/下一题/结算/重开 + logicPatch）。
 * 抽出为纯类是为了可单测（评审 P1：流程逻辑零测试）；LevelRunner 只是其薄壳。
 */
import type { LevelDoc, Question } from '../engine/level'
import type { Json } from '../engine/expr'
import { LogicEngine, type Rule } from '../engine/logic'
import { ComponentStore } from './store'
import type { Effect } from './componentDef'

export interface SessionHost {
  /** 每题装载后回调（渲染层更新进度与题面） */
  onQuestion(index: number, total: number, question: Question | null): void
  /** 结算回调 */
  onFinished(result: { score: Json; passed: boolean }): void
  /** 执行组件命令产生的效果（如播放音频）；注入以便单测时只收集不播放 */
  runEffects(effects: Effect[]): void
  getNowSeconds?(): number
}

export class LevelSession {
  readonly store = new ComponentStore()
  readonly engine: LogicEngine
  private readonly doc: LevelDoc
  private readonly host: SessionHost
  private readonly order: number[] = []
  private pos = 0
  private finishedFlag = false
  private question: Question | null = null
  private emitFns = new Map<string, (event: string, payload?: Json) => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(doc: LevelDoc, host: SessionHost) {
    this.doc = doc
    this.host = host
    const content = doc.content
    this.store.init(content.components)

    this.order = content.questions.map((_, i) => i)
    if (content.flow?.order === 'shuffle') {
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[this.order[i], this.order[j]] = [this.order[j], this.order[i]]
      }
    }
    if (typeof content.flow?.count === 'number') this.order = this.order.slice(0, content.flow.count)

    this.engine = new LogicEngine(content.logic, {
      getQuestion: () => this.question as unknown as Json,
      dispatchCommand: (path, args) => this.handleCommand(path, args),
      getNowSeconds: host.getNowSeconds,
      onError: (err, where) => console.error('[logic]', where, err),
    })

    const problems = LogicEngine.lint(content.logic, { componentIds: content.components.map((c) => c.id) })
    if (problems.length > 0) console.warn('[session] 逻辑 lint:', problems)
    this.warnOrphanBindings()
  }

  get total(): number {
    return this.order.length
  }

  get index(): number {
    return this.pos
  }

  get currentQuestion(): Question | null {
    return this.question
  }

  /** 组件视图发事件的总入口（稳定引用，见 emitFor） */
  dispatch(event: string, payload: Json = {}): void {
    this.engine.dispatch(event, payload)
  }

  /** 每个组件 id 一个稳定的事件发射函数（避免视图因函数引用变化而反复重渲染） */
  emitFor(id: string): (event: string, payload?: Json) => void {
    let fn = this.emitFns.get(id)
    if (!fn) {
      fn = (event, payload) => this.dispatch(`${id}.${event}`, payload ?? {})
      this.emitFns.set(id, fn)
    }
    return fn
  }

  start(): void {
    this.engine.dispatch('level.started', { title: String(this.doc.meta.title ?? '') })
    this.loadQuestion(0)
  }

  restart(): void {
    this.stopAllTimers()
    this.engine.reset()
    this.store.resetAll()
    this.finishedFlag = false
    this.start()
  }

  /** 卸载时清理（LevelRunner 的 effect cleanup 调用） */
  dispose(): void {
    this.stopAllTimers()
  }

  private loadQuestion(p: number): void {
    // 换题即停掉上一题的计时器：logicPatch 的 arm 规则已随题移除，
    // 但已运行的句柄不会自动消失，不清会跨题泄漏触发 tick
    this.stopAllTimers()
    this.pos = p
    const q = this.doc.content.questions[this.order[p]] ?? null
    this.question = q
    this.applyLogicPatch(q)
    for (const comp of this.doc.content.components) {
      if (!comp.bindings) continue
      for (const [key, raw] of Object.entries(comp.bindings)) {
        try {
          this.store.applyBinding(comp.id, key, this.engine.resolve(raw))
        } catch (err) {
          console.error(`[session] 绑定解析失败 ${comp.id}.${key}:`, raw, err)
        }
      }
    }
    this.host.onQuestion(p, this.order.length, q)
    this.engine.dispatch('level.questionLoaded', { index: p, total: this.order.length })
  }

  /**
   * logicPatch 语义：variables 在题目装载时 merge 覆盖引擎变量；
   * appendRules 仅在本题期间生效——每次装载用"基础规则 + 本题追加"重建索引。
   */
  private applyLogicPatch(q: Question | null): void {
    const patch = q?.logicPatch
    const base = this.doc.content.logic.rules
    const rules: Rule[] = patch?.appendRules?.length ? [...base, ...patch.appendRules] : base
    this.engine.setDynamicRules(rules)
    if (patch?.variables) Object.assign(this.engine.vars, structuredClone(patch.variables))
  }

  private handleCommand(path: string, args: Json): void {
    const dot = path.indexOf('.')
    if (dot <= 0) return
    const cid = path.slice(0, dot)
    const cmd = path.slice(dot + 1)
    if (cid === 'level') {
      if (cmd === 'next') {
        if (!this.finishedFlag && this.pos + 1 < this.order.length) this.loadQuestion(this.pos + 1)
        else this.finish()
      } else if (cmd === 'restart') {
        this.restart()
      }
      return
    }
    try {
      const effects = this.store.applyCommand(cid, cmd, args as Record<string, Json>)
      this.runEffects(cid, effects)
    } catch (err) {
      console.error(`[session] 命令执行失败 ${path}:`, err)
    }
  }

  /** timer 效果由会话内部执行（tick 回流为组件事件），其余交给宿主 */
  private runEffects(cid: string, effects: Effect[]): void {
    for (const eff of effects) {
      if (eff.type === 'timer.start') this.startTimer(cid, eff.ms, eff.repeat)
      else if (eff.type === 'timer.stop') this.stopTimer(cid)
      else this.host.runEffects([eff])
    }
  }

  private startTimer(cid: string, ms: number, repeat: boolean): void {
    this.stopTimer(cid)
    let count = 0
    const fire = (): void => {
      count += 1
      try {
        this.store.applyCommand(cid, '__tick', { count })
      } catch (err) {
        console.error(`[session] 计时器状态更新失败 ${cid}:`, err)
      }
      this.dispatch(`${cid}.tick`, { count })
    }
    // 单次与重复分别用 timeout/interval；句柄统一用 clearTimeout 清理
    const handle = repeat ? setInterval(fire, ms) : setTimeout(fire, ms)
    this.timers.set(cid, handle)
  }

  private stopTimer(cid: string): void {
    const handle = this.timers.get(cid)
    if (handle !== undefined) {
      clearTimeout(handle)
      this.timers.delete(cid)
    }
  }

  private stopAllTimers(): void {
    for (const handle of this.timers.values()) clearTimeout(handle)
    this.timers.clear()
  }

  private finish(): void {
    // 幂等守卫：已结算后再触发（如 UGC 规则 on finished → level.next）直接忽略，
    // 否则会形成 finish → level.finished → level.next → finish 的无界同步递归
    if (this.finishedFlag) return
    this.finishedFlag = true
    let passed = true
    if (this.doc.content.flow?.pass?.expr) {
      try {
        passed = Boolean(this.engine.evaluate(this.doc.content.flow.pass.expr))
      } catch (err) {
        // 通过线表达式出错时降级为"未通过"，绝不能卡死用户
        console.error('[session] flow.pass 求值失败，按未通过处理:', err)
        passed = false
      }
    }
    const score = this.engine.vars.score ?? 0
    this.host.onFinished({ score, passed })
    this.engine.dispatch('level.finished', { score, passed })
  }

  /** 绑定路径存在性检查（警告级）：$q.path 至少要在一个题目里能解析 */
  private warnOrphanBindings(): void {
    const hasPath = (obj: unknown, parts: string[]): boolean => {
      let cur: unknown = obj
      for (const part of parts) {
        if (cur === null || typeof cur !== 'object' || !(part in (cur as object))) return false
        cur = (cur as Record<string, unknown>)[part]
      }
      return true
    }
    for (const comp of this.doc.content.components) {
      for (const [key, raw] of Object.entries(comp.bindings ?? {})) {
        if (typeof raw !== 'string' || !raw.startsWith('$q.')) continue
        const parts = raw.slice(3).split('.')
        const found = this.doc.content.questions.some((q) => hasPath(q, parts))
        if (!found) console.warn(`[session] 绑定 ${comp.id}.${key} = "${raw}" 在任何题目中都不存在`)
      }
    }
  }
}
