/**
 * GraphEngine：GraphProgram 的 async 执行器（docs/12 §7）。
 *
 * 语义契约（docs/13 §4，3-0 评审钉死）：
 * - branch/loop 缺 false 边 = 该路径处理器结束
 * - emit payload 缺省 = {}；call args [] = {}
 * - loop 体回边 = 指向 loop 节点的入边；loop 的 false 出边 = 循环后继
 * - comment 节点执行直通；on 节点无入边
 *
 * 并发模型：dispatch 把事件入队并启动 drain 循环；同一事件的多个处理器按程序顺序
 * 串行 await，不同事件的任务并行（wait 期间不阻塞其它事件）。每次 await 返回后检查
 * generation——reset/restart 即刻作废进行中的执行。节点预算按处理器计数，防死循环。
 *
 * 传入 v1 LogicProgram 时构造器内透明迁移（ECA→图，见 migrate.ts）。
 */
import { evalExpr, type ExprContext, type ExprScope, type Json } from './expr'
import { isGraphProgram, type GEdge, type GNode, type GraphProgram } from './graphProgram'
import { migrateLogicV1toV2 } from './migrate'
import type { LogicProgram } from './logic'

export interface GraphBudgets {
  /** 单表达式步数（默认 1000） */
  exprSteps?: number
  /** 级联队列最多处理的事件数（默认 64） */
  maxEvents?: number
  /** 单个处理器最多执行的节点数（默认 512） */
  maxNodes?: number
}

export interface GraphHost {
  /** 当前题目对象（表达式作用域 q） */
  getQuestion(): Json | null
  /** 命令分发（实例id.方法 / level.next 等），由宿主实现 */
  dispatchCommand(path: string, args: Json): void
  /** 查询方法调用（assign 右侧的 target.method(args)）；未实现时查询节点抛错 */
  queryComponent?(target: string, method: string, args: Json[]): Json
  getNowSeconds?: () => number
  onError?: (err: unknown, context: { nodeId?: string; event?: string }) => void
  budgets?: GraphBudgets
}

interface QueuedEvent {
  event: string
  payload: Json
}

interface Index {
  byId: Map<string, GNode>
  /** 事件 → on 节点列表（按程序顺序） */
  onsByEvent: Map<string, GNode[]>
  outEdges: Map<string, GEdge[]>
  /** loop 体回边的来源集合：从 true 出边可达且回到 loop 的节点（用于 repeat 计数器重置判定） */
  loopBodySources: Map<string, Set<string>>
}

export class GraphEngine {
  vars: Record<string, Json>
  private program: GraphProgram
  private host: GraphHost
  private initialVars: Record<string, Json>
  private generation = 0
  private queue: QueuedEvent[] = []
  private draining = false
  private eventsProcessed = 0
  private idx: Index

  constructor(program: GraphProgram | LogicProgram, host: GraphHost) {
    this.host = host
    this.program = isGraphProgram(program) ? program : migrateLogicV1toV2(program)
    this.initialVars = structuredClone(this.program.variables ?? {})
    this.vars = structuredClone(this.initialVars)
    this.idx = this.buildIndex(this.program)
  }

  private buildIndex(program: GraphProgram): Index {
    const byId = new Map<string, GNode>()
    const onsByEvent = new Map<string, GNode[]>()
    const outEdges = new Map<string, GEdge[]>()
    for (const node of program.nodes) {
      byId.set(node.id, node)
      if (node.kind === 'on') {
        const list = onsByEvent.get(node.event) ?? []
        list.push(node)
        onsByEvent.set(node.event, list)
      }
    }
    for (const e of program.edges) {
      const list = outEdges.get(e.from) ?? []
      list.push(e)
      outEdges.set(e.from, list)
    }
    const loopBodySources = new Map<string, Set<string>>()
    for (const node of program.nodes) {
      if (node.kind !== 'loop') continue
      // 体集合：从 true 出边 DFS，遇本 loop 停（true 出边直接自环 = 空体回边，自身即体来源）
      const body = new Set<string>()
      const stack: string[] = []
      const t = this.portOut(outEdges, node.id, 'true')
      if (t === node.id) body.add(node.id)
      else if (t) stack.push(t)
      while (stack.length) {
        const id = stack.pop()!
        if (id === node.id || body.has(id)) continue
        body.add(id)
        for (const e of outEdges.get(id) ?? []) stack.push(e.to)
      }
      // 回边来源：指向本 loop 的边中，起点在体内
      const sources = new Set<string>()
      for (const e of program.edges) {
        if (e.to === node.id && body.has(e.from)) sources.add(e.from)
      }
      loopBodySources.set(node.id, sources)
    }
    return { byId, onsByEvent, outEdges, loopBodySources }
  }

  private portOut(outEdges: Map<string, GEdge[]>, from: string, port?: 'true' | 'false'): string | null {
    const e = (outEdges.get(from) ?? []).find((x) => x.port === port)
    return e ? e.to : null
  }

  /**
   * 替换动态程序（题目 logicPatch 用）：以基础程序 + 本题追加片段重建索引，变量不受影响。
   */
  setDynamicProgram(program: GraphProgram): void {
    this.program = program
    this.idx = this.buildIndex(program)
  }

  /** 入口：派发事件（fire-and-forget async）。内部 emit 的事件级联处理，受预算约束。 */
  dispatch(event: string, payload: Json = {}): void {
    this.queue.push({ event, payload })
    if (!this.draining) void this.drain()
  }

  private async drain(): Promise<void> {
    this.draining = true
    let gen = this.generation
    try {
      const maxEvents = this.host.budgets?.maxEvents ?? 64
      while (this.queue.length > 0) {
        // 代数变化（reset/restart）= 放弃当前批次；队列中剩余事件属新一代（reset 已清队，
        // 这里只会是 reset 之后新入队的生命周期事件），换代继续消费而不是让 drain 带队殉葬
        if (this.generation !== gen) {
          gen = this.generation
          this.eventsProcessed = 0
        }
        if (this.eventsProcessed >= maxEvents) {
          this.fail(new Error(`事件级联超过预算（${maxEvents}）`), { event: '' })
          this.queue.length = 0
          return
        }
        const { event, payload } = this.queue.shift()!
        this.eventsProcessed++
        for (const on of this.idx.onsByEvent.get(event) ?? []) {
          if (this.generation !== gen) break
          await this.runHandler(on, payload, gen, event)
        }
      }
    } finally {
      this.draining = false
      this.eventsProcessed = 0
    }
  }

  /** 执行一个事件处理器：从 on 节点沿执行边行走 */
  private async runHandler(onNode: GNode, payload: Json, gen: number, event: string): Promise<void> {
    const scope: ExprScope = { event: payload, q: this.host.getQuestion(), v: this.vars }
    const ectx: ExprContext = {
      getNowSeconds: this.host.getNowSeconds,
      stepBudget: this.host.budgets?.exprSteps ?? 1000,
    }
    const maxNodes = this.host.budgets?.maxNodes ?? 512
    let steps = 0
    // repeat 计数器：按 loop 节点记剩余次数；从顺序边进入时重置，体回边进入时保持
    const counters = new Map<string, number>()
    let prev: string | null = null
    let cur: string | null = this.portOut(this.idx.outEdges, onNode.id)
    while (cur) {
      if (this.generation !== gen) return
      if (++steps > maxNodes) {
        this.fail(new Error('节点执行数超过预算'), { event, nodeId: cur })
        return
      }
      const node = this.idx.byId.get(cur)
      if (!node) {
        this.fail(new Error(`执行边指向不存在的节点 "${cur}"`), { event, nodeId: cur })
        return
      }
      try {
        cur = await this.execNode(node, prev, scope, ectx, counters, gen)
      } catch (err) {
        // 单节点失败：中断本处理器，其它处理器/事件不受影响
        this.fail(err, { event, nodeId: node.id })
        return
      }
      prev = node.id
    }
  }

  private async execNode(
    node: GNode,
    prev: string | null,
    scope: ExprScope,
    ectx: ExprContext,
    counters: Map<string, number>,
    gen: number,
  ): Promise<string | null> {
    switch (node.kind) {
      case 'on':
        throw new Error('on 节点不能被顺序执行到')
      case 'comment':
        return this.nextOf(node.id)
      case 'call': {
        const args = (node.args ?? []).map((src) => evalExpr(src, scope, ectx))
        const argv: Json = args.length > 0 ? args[0] : {}
        this.host.dispatchCommand(`${node.target}.${node.method}`, argv)
        return this.nextOf(node.id)
      }
      case 'assign': {
        const value = node.value
        this.vars[node.target] = 'expr' in value ? evalExpr(value.expr, scope, ectx) : this.execQuery(value.call, scope, ectx)
        return this.nextOf(node.id)
      }
      case 'emit': {
        const payload: Record<string, Json> = {}
        for (const [k, src] of Object.entries(node.payload ?? {})) payload[k] = evalExpr(src, scope, ectx)
        this.queue.push({ event: node.event, payload })
        return this.nextOf(node.id)
      }
      case 'branch': {
        const truthy = Boolean(evalExpr(node.cond, scope, ectx))
        return this.portOut(this.idx.outEdges, node.id, truthy ? 'true' : 'false')
      }
      case 'loop': {
        let again: boolean
        if (node.mode === 'while') {
          again = Boolean(evalExpr(node.cond ?? 'false', scope, ectx))
        } else {
          // repeat：从顺序边进入重置计数，体回边进入继续递减
          const isBodyReturn = prev !== null && (this.idx.loopBodySources.get(node.id)?.has(prev) ?? false)
          let left = counters.get(node.id)
          if (left === undefined || !isBodyReturn) {
            left = Number(evalExpr(node.times ?? '0', scope, ectx)) || 0
          }
          again = left > 0
          counters.set(node.id, again ? left - 1 : 0)
        }
        return this.portOut(this.idx.outEdges, node.id, again ? 'true' : 'false')
      }
      case 'wait': {
        const raw = Number(evalExpr(node.ms, scope, ectx))
        const ms = Number.isFinite(raw) ? Math.max(0, raw) : 0
        await sleep(ms)
        // await 返回后检查：reset/restart 已作废本次执行
        if (this.generation !== gen) return null
        return this.nextOf(node.id)
      }
    }
  }

  private execQuery(call: { target: string; method: string; args: string[] }, scope: ExprScope, ectx: ExprContext): Json {
    if (call.target === 'level') throw new Error(`level 没有 "${call.method}" 查询方法`)
    const args = (call.args ?? []).map((src) => evalExpr(src, scope, ectx))
    if (!this.host.queryComponent) throw new Error(`宿主未实现组件查询（${call.target}.${call.method}）`)
    return this.host.queryComponent(call.target, call.method, args)
  }

  private nextOf(id: string): string | null {
    return this.portOut(this.idx.outEdges, id)
  }

  /** 深度解析 "$q.…"/"$event.…"/"$v.…"/"$expr:…" 引用（组件 bindings 用，与 v1 同语义） */
  resolve(value: Json, scope?: ExprScope): Json {
    const s: ExprScope = scope ?? { event: {}, q: this.host.getQuestion(), v: this.vars }
    const ectx: ExprContext = { getNowSeconds: this.host.getNowSeconds }
    const refRe = /^\$(q|event|v)(\.[A-Za-z_]\w*)+$/
    const walk = (v: Json): Json => {
      if (typeof v === 'string') {
        if (v.startsWith('$expr:')) return evalExpr(v.slice(6), s, ectx)
        if (refRe.test(v)) return evalExpr(v.slice(1), s, ectx)
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
    // 代数 +1：作废任何进行中处理器（含 wait 挂起点）
    // 原地清空再回填，保持 vars 对象身份不变（同 v1 语义，见 logic.ts reset）
    this.generation += 1
    this.queue.length = 0
    this.eventsProcessed = 0
    for (const key of Object.keys(this.vars)) delete this.vars[key]
    Object.assign(this.vars, structuredClone(this.initialVars))
  }

  private fail(err: unknown, context: { nodeId?: string; event?: string }): void {
    if (this.host.onError) this.host.onError(err, context)
    else console.error('[graph-engine]', context, err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
