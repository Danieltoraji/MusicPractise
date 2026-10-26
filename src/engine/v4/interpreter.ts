/**
 * v4 通用图执行器（docs/53 §6–§7）：Flow 与 Behavior 共用的走链/端口/循环/foreach/表达式节点。
 *
 * 设计：
 * - `GraphIndex`：一次构建的节点/出边索引，`next(nodeId, port)` 按端口取唯一后继；
 * - `runChain`：从入口沿边线性推进（循环靠「体尾回边回到 loop/foreach 节点」实现，
 *   循环状态存于 WalkFrame.loopState，不走递归）；
 * - `execSharedNode`：assign / call / branch / loop / foreach / wait / comment 的共享语义；
 *   返回 null 表示该 kind 由层宿主（Flow/Behavior）处理；
 * - 取消令牌与步数预算在每节点前后检查（等待类节点由宿主 sleep 实现配合取消）。
 *
 * 本模块不接触作用域具体形态：赋值/求值/命令/查询/休眠由 `SharedEnv` 注入，
 * 因此 flow（v/local/run）与 behavior（q/t/local/args/v/run/event）可复用同一执行器。
 */
import type { Json } from '../expr'
import type { GraphEdge, RValue } from './model'

export class CancelledError extends Error {
  constructor(message = '执行已取消') {
    super(message)
    this.name = 'CancelledError'
  }
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetExceededError'
  }
}

export class FlowRuntimeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlowRuntimeError'
  }
}

// ---------------------------------------------------------------------------
// 取消令牌 + 步数预算
// ---------------------------------------------------------------------------

export class CancelToken {
  private listeners = new Set<() => void>()
  private cancelledFlag = false

  get cancelled(): boolean {
    return this.cancelledFlag
  }

  cancel(): void {
    if (this.cancelledFlag) return
    this.cancelledFlag = true
    for (const listener of [...this.listeners]) listener()
    this.listeners.clear()
  }

  throwIfCancelled(): void {
    if (this.cancelledFlag) throw new CancelledError()
  }

  /** 注册取消回调；返回解绑函数（已取消时立即回调） */
  onCancel(listener: () => void): () => void {
    if (this.cancelledFlag) {
      listener()
      return () => {}
    }
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export class StepBudget {
  private used = 0

  constructor(private readonly max: number) {}

  consume(): void {
    this.used += 1
    if (this.used > this.max) {
      throw new BudgetExceededError(`执行步数超过预算（${this.max} 步）`)
    }
  }

  get usedCount(): number {
    return this.used
  }
}

/** 可取消的休眠（session 可注入假计时器；测试用 vi.useFakeTimers 也可） */
export function sleepWithCancel(
  ms: number,
  cancel: CancelToken,
  timer: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void } = {
    setTimeout: (fn, delay) => setTimeout(fn, delay),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): Promise<void> {
  const delay = Math.min(Math.max(0, Math.trunc(ms)), 600_000)
  return new Promise<void>((resolve, reject) => {
    if (delay <= 0) {
      resolve()
      return
    }
    const handle = timer.setTimeout(() => {
      off()
      resolve()
    }, delay)
    const off = cancel.onCancel(() => {
      timer.clearTimeout(handle)
      reject(new CancelledError())
    })
  })
}

// ---------------------------------------------------------------------------
// 图索引
// ---------------------------------------------------------------------------

export interface GraphNodeLike {
  id: string
  kind: string
}

export type Port = 'true' | 'false'

/** 一次链式执行期间的可变状态（循环迭代进度） */
export interface WalkFrame {
  loopState: Map<string, LoopRuntimeState>
}

export type LoopRuntimeState =
  | { kind: 'repeat'; remaining: number }
  | { kind: 'foreach'; items: Json[]; index: number }

export class GraphIndex<N extends GraphNodeLike> {
  readonly nodes = new Map<string, N>()
  private readonly out = new Map<string, GraphEdge[]>()

  constructor(program: { nodes: N[]; edges: GraphEdge[] }) {
    for (const node of program.nodes) this.nodes.set(node.id, node)
    for (const edge of program.edges) {
      const list = this.out.get(edge.from)
      if (list) list.push(edge)
      else this.out.set(edge.from, [edge])
    }
  }

  node(id: string): N | undefined {
    return this.nodes.get(id)
  }

  /** 指定端口（省略 = 单出口边）的后继节点 id；无出边返回 null */
  next(nodeId: string, port?: Port): string | null {
    const edges = this.out.get(nodeId)
    if (!edges) return null
    const edge = edges.find((candidate) => candidate.port === port)
    return edge ? edge.to : null
  }

  outDegree(nodeId: string): number {
    return this.out.get(nodeId)?.length ?? 0
  }
}

// ---------------------------------------------------------------------------
// 共享节点语义
// ---------------------------------------------------------------------------

export interface SharedEnv {
  /** 按层作用域求值表达式（值必须是 Json） */
  evalExpr(src: string): Json
  /** 按层写入赋值目标（v.x / q.state.x / t.x / local.x） */
  writeTarget(target: string, value: Json): void
  /** 局部变量（foreach/loop/ask 结果写回用） */
  setLocal(name: string, value: Json): void
  readLocal(name: string): Json
  /** 组件命令（单参对象） */
  command(target: string, method: string, arg: Json): void | Promise<void>
  /** 组件查询（assign 右侧） */
  query(target: string, method: string, arg?: Json): Json
  /** 可取消休眠 */
  sleep(ms: number): Promise<void>
}

export interface StepResult {
  port?: Port
}

function evalNumber(env: SharedEnv, src: string, what: string): number {
  const value = env.evalExpr(src)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FlowRuntimeError(`${what} 必须是有限数字（实际: ${JSON.stringify(value)}）`)
  }
  return value
}

/** 求值 RValue（{expr} 或 {query}） */
export function evalRValue(env: SharedEnv, value: RValue): Json {
  if (value && typeof value === 'object' && 'expr' in value) {
    return env.evalExpr((value as { expr: string }).expr)
  }
  if (value && typeof value === 'object' && 'query' in value) {
    const query = (value as { query: { target: string; method: string; arg?: string } }).query
    const arg = query.arg !== undefined ? env.evalExpr(query.arg) : undefined
    return env.query(query.target, query.method, arg)
  }
  throw new FlowRuntimeError('非法的取值节点（需要 {expr} 或 {query}）')
}

/**
 * 执行共享节点。返回 StepResult = 已处理；返回 null = 该 kind 由层宿主处理。
 * 调用方负责在节点执行前调用 debug gate。
 */
export async function execSharedNode(
  node: GraphNodeLike,
  frame: WalkFrame,
  env: SharedEnv,
  cancel: CancelToken,
): Promise<StepResult | null> {
  switch (node.kind) {
    case 'assign': {
      const assign = node as unknown as { target: string; value: RValue }
      const value = evalRValue(env, assign.value)
      env.writeTarget(assign.target, value)
      return {}
    }
    case 'call': {
      const call = node as unknown as { target: string; method: string; arg?: string }
      const argValue = call.arg !== undefined ? env.evalExpr(call.arg) : {}
      const arg = argValue === null || argValue === undefined ? {} : argValue
      if (typeof arg !== 'object' || Array.isArray(arg)) {
        throw new FlowRuntimeError(`call 参数必须是对象（实际: ${JSON.stringify(argValue)}）`)
      }
      await env.command(call.target, call.method, arg)
      cancel.throwIfCancelled()
      return {}
    }
    case 'branch': {
      const branch = node as unknown as { cond: string }
      return { port: Boolean(env.evalExpr(branch.cond)) ? 'true' : 'false' }
    }
    case 'loop': {
      const loop = node as unknown as { mode: 'while' | 'repeat'; cond?: string; times?: string }
      if (loop.mode === 'while') {
        if (loop.cond === undefined) throw new FlowRuntimeError('loop while 缺少 cond')
        return { port: Boolean(env.evalExpr(loop.cond)) ? 'true' : 'false' }
      }
      let state = frame.loopState.get(node.id)
      if (!state || state.kind !== 'repeat') {
        const times = loop.times !== undefined ? evalNumber(env, loop.times, 'loop repeat 次数') : 0
        state = { kind: 'repeat', remaining: Math.max(0, Math.trunc(times)) }
        frame.loopState.set(node.id, state)
      }
      if (state.remaining <= 0) {
        frame.loopState.delete(node.id)
        return { port: 'false' }
      }
      state.remaining -= 1
      return { port: 'true' }
    }
    case 'foreach': {
      const foreach = node as unknown as { items: string; itemVar: string; indexVar?: string }
      let state = frame.loopState.get(node.id)
      if (!state || state.kind !== 'foreach') {
        const items = env.evalExpr(foreach.items)
        if (!Array.isArray(items)) {
          throw new FlowRuntimeError(`foreach 的 items 必须是数组（实际: ${JSON.stringify(items)}）`)
        }
        state = { kind: 'foreach', items, index: 0 }
        frame.loopState.set(node.id, state)
      }
      if (state.index >= state.items.length) {
        frame.loopState.delete(node.id)
        return { port: 'false' }
      }
      env.setLocal(foreach.itemVar, state.items[state.index])
      if (foreach.indexVar) env.setLocal(foreach.indexVar, state.index)
      state.index += 1
      return { port: 'true' }
    }
    case 'wait': {
      const wait = node as unknown as { ms: string }
      const ms = evalNumber(env, wait.ms, 'wait 毫秒数')
      await env.sleep(ms)
      cancel.throwIfCancelled()
      return {}
    }
    case 'comment':
      return {}
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// 链式执行
// ---------------------------------------------------------------------------

export interface RunChainOptions<N extends GraphNodeLike> {
  entry: string
  index: GraphIndex<N>
  cancel: CancelToken
  budget: StepBudget
  /** 执行单个节点（共享节点由调用方先尝试 execSharedNode）；返回端口/空 */
  exec(node: N): Promise<StepResult | void>
}

/**
 * 从 entry 沿边线性执行直到无出边。
 * 循环体是「体尾回边指向 loop/foreach 节点」，再次执行该节点时由 loopState 推进/退出——
 * 与 v3 的 loop 回边结构同构，不需要递归或结构化子图。
 */
export async function runChain<N extends GraphNodeLike>(options: RunChainOptions<N>): Promise<void> {
  const { entry, index, cancel, budget } = options
  let current: string | null = entry
  while (current !== null) {
    cancel.throwIfCancelled()
    const node = index.node(current)
    if (!node) throw new FlowRuntimeError(`节点 "${current}" 不存在`)
    budget.consume()
    const result = await options.exec(node)
    cancel.throwIfCancelled()
    current = index.next(node.id, result?.port)
  }
}
