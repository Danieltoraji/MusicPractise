/**
 * 关卡会话：与 React 无关的流程核心（v3：视图切换 + 数据表行推进）。
 * - 视图 = 互斥渲染边界：当前视图的组件才渲染；切换派发 view.entered {view}
 * - 数据表行 = 题目：q.* 指向当前行；question.next 推进到下一题（末题结算）；
 *   赋值 v.__row = N 即跳转第 N 题（rowPointerWrite 钩子）——换行不切视图，
 *   当前视图内容随行刷新（loadRow 重放绑定；无绑定组件靠 question.loaded 重放命令）
 * - 逻辑执行 = GraphEngine（图 IR v2）；v3 文档已无 logicPatch（迁移器编译为图上的行门控子图）
 * 抽出为纯类是为了可单测；LevelRunner 只是其薄壳。
 */
import type { LevelDoc, TableRow, ViewDef } from '../engine/level'
import type { Json } from '../engine/expr'
import { GraphEngine } from '../engine/graphEngine'
import { isGraphProgram, lintGraphProgram, QUESTION_LOADED_EVENT, ROW_POINTER_VAR, type GraphProgram } from '../engine/graphProgram'
import { migrateLogicV1toV2 } from '../engine/migrate'
import { ComponentStore } from './store'
import type { Effect } from './componentDef'

/** 运行日志事件（节点图「运行日志」面板的数据源；nodeId 可定位到图上节点） */
export type LogicRunEvent =
  | { kind: 'error'; message: string; nodeId?: string; event?: string; t: number }
  | { kind: 'command'; path: string; event?: string; t: number }

export interface SessionHost {
  /** 每行装载后回调（渲染层更新进度与题面） */
  onRow(index: number, total: number, row: TableRow | null): void
  /** 视图切换回调（含初始进入与 restart 复位；渲染层据此切换渲染的组件集合） */
  onView(id: string): void
  /** 结算回调 */
  onFinished(result: { score: Json; passed: boolean }): void
  /** 执行组件命令产生的效果（如播放音频）；注入以便单测时只收集不播放 */
  runEffects(effects: Effect[]): void
  getNowSeconds?(): number
  /** 可选：逻辑运行事件（错误/命令轨迹），供「运行日志」面板收集 */
  onLogicEvent?(e: LogicRunEvent): void
}

export class LevelSession {
  readonly store = new ComponentStore()
  readonly engine: GraphEngine
  private readonly doc: LevelDoc
  private readonly host: SessionHost
  private readonly baseProgram: GraphProgram
  private readonly views: ViewDef[]
  private readonly order: number[] = []
  private pos = 0
  private finishedFlag = false
  private row: TableRow | null = null
  private view = ''
  private emitFns = new Map<string, (event: string, payload?: Json) => void>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(doc: LevelDoc, host: SessionHost) {
    this.doc = doc
    this.host = host
    const content = doc.content
    // 视图清单防御：缺失/为空时回退默认主视图（正常路径由装载管线保证）
    this.views = content.views.length > 0 ? content.views : [{ id: 'main', name: '主视图' }]
    this.store.init(content.components)
    // 视图直调 applyCommand 产生的效果（点击发音等）与规则链路共用同一执行通道
    this.store.setEffectSink((cid, effects) => this.runEffects(cid, effects))

    this.order = content.table.rows.map((_, i) => i)
    if (content.flow?.order === 'shuffle') {
      for (let i = this.order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[this.order[i], this.order[j]] = [this.order[j], this.order[i]]
      }
    }
    if (typeof content.flow?.count === 'number') this.order = this.order.slice(0, content.flow.count)

    this.baseProgram = isGraphProgram(content.logic) ? content.logic : migrateLogicV1toV2(content.logic)
    this.engine = new GraphEngine(this.baseProgram, {
      getQuestion: () => this.row as unknown as Json,
      dispatchCommand: (path, args, context) => this.handleCommand(path, args, context),
      // 行指针赋值 = 跳转题目行（docs/25）：clamp 到有效行区间，重复行 no-op 防事件环
      rowPointerWrite: (row) => this.jumpToRow(row),
      queryComponent: (target, method, args) => this.store.query(target, method, args),
      getNowSeconds: host.getNowSeconds,
      onError: (err, where) => {
        console.error('[logic]', where, err)
        this.host.onLogicEvent?.({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
          nodeId: where?.nodeId,
          event: where?.event,
          t: Date.now(),
        })
      },
    })

    const problems = lintGraphProgram(this.baseProgram, {
      componentIds: content.components.map((c) => c.id),
      viewIds: this.views.map((v) => v.id),
    })
    if (problems.length > 0) console.warn('[session] 逻辑 lint:', problems)
    this.warnOrphanBindings()
  }

  get total(): number {
    return this.order.length
  }

  get index(): number {
    return this.pos
  }

  get currentRow(): TableRow | null {
    return this.row
  }

  get currentView(): string {
    return this.view
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
    // 初始视图进入（restart 时 view 已清空 → 必然重新派发 view.entered）
    this.setView(this.views[0].id)
    this.loadRow(0)
  }

  restart(): void {
    this.stopAllTimers()
    this.engine.reset()
    this.store.resetAll()
    this.finishedFlag = false
    this.view = '' // 强制重新进入初始视图（派发 view.entered）
    this.start()
  }

  /** 卸载时清理（LevelRunner 的 effect cleanup 调用）：作废进行中的处理器，防止僵尸命令/音频 */
  dispose(): void {
    this.stopAllTimers()
    this.engine.reset()
    this.view = '' // 防御：dispose 后复用实例再 start 时，初始视图必须重新派发 view.entered（评审 P2-8）
  }

  /**
   * 切换视图：应用该视图组件的数据绑定（指向当前行）→ 派发 view.entered。
   * 同视图重复 goto = no-op（防 handler 里 goto 自己造成事件环）。
   */
  private setView(id: string): void {
    if (!this.views.some((v) => v.id === id)) {
      this.host.onLogicEvent?.({ kind: 'error', message: `views.goto 指向不存在的视图 "${id}"`, event: 'views.goto', t: Date.now() })
      return
    }
    if (this.view === id) return
    this.view = id
    this.host.onView(id)
    this.applyBindings(id)
    this.engine.dispatch('view.entered', { view: id })
  }

  /** 应用某视图组件的绑定（$q.<列>… 解析为当前行；视图切换与换行两个时机都会调用） */
  private applyBindings(viewId: string): void {
    if (this.row === null) return // 初始视图进入时还没有行；loadRow 会立即按当前行应用绑定
    for (const comp of this.doc.content.components) {
      if ((comp.view ?? this.views[0].id) !== viewId) continue
      for (const [key, raw] of Object.entries(comp.bindings ?? {})) {
        try {
          this.store.applyBinding(comp.id, key, this.engine.resolve(raw))
        } catch (err) {
          console.error(`[session] 绑定解析失败 ${comp.id}.${key}:`, raw, err)
          this.host.onLogicEvent?.({
            kind: 'error',
            message: `绑定解析失败 ${comp.id}.${key}: ${err instanceof Error ? err.message : String(err)}`,
            event: 'binding',
            t: Date.now(),
          })
        }
      }
    }
  }

  /** 推进到第 p 行（按 flow 顺序）；绑定重放 + onRow 回调 + question.loaded */
  private loadRow(p: number): void {
    // 换行即停掉上一行的计时器：编译进图的行门控逻辑不会跨行触发，但已运行的句柄不会自动消失
    this.stopAllTimers()
    this.pos = p
    this.row = this.doc.content.table.rows[this.order[p]] ?? null
    // 系统变量 __row = 原始行号：迁移器编译的行门控子图（logicPatch）据此判行——
    // 它可能在任意事件（x.ping/timer.tick…）上触发，那些事件的负载里没有行号。
    // 直写字段不经 rowPointerWrite 钩子（否则赋值跳行会在这里递归触发自身）
    this.engine.vars[ROW_POINTER_VAR] = this.order[p]
    this.applyBindings(this.view)
    this.host.onRow(p, this.order.length, this.row)
    // payload.row = 原始行号（shuffle 下与 index 不同）——迁移器编译的行门控子图据此判行
    this.engine.dispatch(QUESTION_LOADED_EVENT, { index: p, total: this.order.length, row: this.order[p] })
  }

  /**
   * 赋值 v.__row = N：跳转到原始行号为 N 的题（与门控表达式 v.__row == i 同一语义）。
   * shuffle/count 下按行号反查 flow 位置；行号不在本局（被 count 抽掉）则忽略。
   * 同行 no-op 防事件环；结算后终态忽略。
   */
  private jumpToRow(row: number): void {
    if (this.finishedFlag || this.order.length === 0) return
    const target = Math.trunc(row)
    const pos = this.order.indexOf(target)
    if (pos === -1 || pos === this.pos) return
    this.loadRow(pos)
  }

  private handleCommand(path: string, args: Json, context?: { nodeId?: string; event?: string }): void {
    this.host.onLogicEvent?.({ kind: 'command', path, t: Date.now() })
    const dot = path.indexOf('.')
    if (dot <= 0) return
    const cid = path.slice(0, dot)
    const cmd = path.slice(dot + 1)
    if (cid === 'question') {
      if (cmd === 'next') {
        // 下一题：纯推进行（换行不切视图，当前视图内容随 loadRow 刷新）；末题则结算关卡
        if (!this.finishedFlag && this.pos + 1 < this.order.length) this.loadRow(this.pos + 1)
        else this.finish()
      }
      return
    }
    if (cid === 'level') {
      if (cmd === 'restart') {
        this.restart()
      } else if (cmd === 'finish') {
        // level facade：主动结算（args.passed === false 时强制未通过）
        const passedArg = args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, Json>).passed : undefined
        this.finish(passedArg === false ? false : undefined)
      }
      return
    }
    if (cid === 'views') {
      // views.goto：argv = 视图 id 字符串（或 {id}）
      const target =
        typeof args === 'string' ? args : args !== null && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, Json>).id : undefined
      if (typeof target !== 'string' || target === '') {
        this.host.onLogicEvent?.({
          kind: 'error',
          message: 'views.goto 缺少视图 id（字符串字面量）',
          nodeId: context?.nodeId,
          event: context?.event,
          t: Date.now(),
        })
        return
      }
      this.setView(target)
      return
    }
    try {
      // 效果在 applyCommand 内经 sink 转入 runEffects，这里不再重复执行
      this.store.applyCommand(cid, cmd, args as Record<string, Json>)
    } catch (err) {
      console.error(`[session] 命令执行失败 ${path}:`, err)
      // 命令执行失败（未知实例/未知命令）进运行日志：排查「点了没反应」的主要线索
      this.host.onLogicEvent?.({
        kind: 'error',
        message: `命令执行失败 ${path}: ${err instanceof Error ? err.message : String(err)}`,
        nodeId: context?.nodeId,
        event: context?.event ?? path,
        t: Date.now(),
      })
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

  private finish(passedArg?: boolean): void {
    // 幂等守卫：已结算后再触发（如 on finished → question.next）直接忽略，
    // 否则会形成 finish → level.finished → question.next → finish 的无界同步递归
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
    // level.finish(false) 显式强制未通过
    if (passedArg === false) passed = false
    // 结算即终态：停掉计时器，防止 repeat tick 在结算后继续驱动规则改状态/文案
    this.stopAllTimers()
    const score = this.engine.vars.score ?? 0
    this.host.onFinished({ score, passed })
    this.engine.dispatch('level.finished', { score, passed })
  }

  /** 绑定路径存在性检查（警告级）：$q.path 至少要在一行里能解析 */
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
        const found = this.doc.content.table.rows.some((row) => hasPath(row, parts))
        if (!found) console.warn(`[session] 绑定 ${comp.id}.${key} = "${raw}" 在任何数据行中都不存在`)
      }
    }
  }
}
