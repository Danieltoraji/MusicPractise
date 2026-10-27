/**
 * v4 伪代码投影（docs/53 §13.5）：FlowProgram / BehaviorProgram ↔ 文本。
 *
 * 定位（与 v3 `engine/script.ts` 同源）：图是唯一真源，伪代码是**单向可逆投影**——
 * - `generateFlowScript` / `generateBehaviorScript`：IR → 文本。语句与节点一一对应；
 *   图超出「结构化子集」（多路径汇入、循环体不回头、注释接线等）时抛可读中文错误
 *   （自由图仍可在节点图/JSON 里编辑）；
 * - `parseFlowScript` / `parseBehaviorScript`：文本 → IR。表达式提取后交给 v4 表达式校验器
 *   （`checkV4Expr`），语法错误带行列号与中文说明；注释/变量声明也可往返；
 * - `mergeFlowScriptAnchors` / `mergeBehaviorScriptAnchors`：二次编辑锚点合并（docs/53 §13.5
 *   要求）：按语句特征配对，配对成功的节点继承旧 id 与 x/y；未配对节点保留解析产物 id；
 *   合并后自检 id 唯一、无悬空边/自环，违反直接抛错（脚本页阻止应用）。
 *
 * 往返恒等口径：`generate(parse(generate(p))) === generate(p)`（与 v3 一致）。
 * 文本格式（与 docs/53 §13.5 示例同构）：
 *
 *   vars {
 *     v.score: number = 0
 *   }
 *   main {
 *     // 注释
 *     v.score = 0
 *     foreach slot, i in run.questions {
 *       ask local.slot -> result
 *       if (result.scoreDelta != null) {
 *         v.score = v.score + result.scoreDelta
 *       }
 *     }
 *     finish passed: v.score >= 60
 *   }
 *
 *   locals { local.hits: number = 0 }
 *   on start {
 *     call sound1.play({notes: q.notes})
 *   }
 *   on choice1.chosen {
 *     if (event.payload.index == q.answerIndex) {
 *       q.state.answered = true
 *       return { status: 'answered', correct: true, scoreDelta: q.scoring }
 *     }
 *   }
 *
 * 约束：语句一行一条（表达式不跨行）；分支/循环用 `{ }` 块；`if/while/repeat/foreach`
 * 的块由解析器按「双端口 + 体尾回边」重建为边，因此只能表达该结构化子集。
 */
import type { Json } from '../expr'
import type {
  BehaviorNode,
  BehaviorProgram,
  FlowNode,
  FlowProgram,
  GraphEdge,
  RValue,
  StateFieldDef,
  StateType,
} from './model'
import { LOGIC_VERSION_V4 } from './model'
import { BEHAVIOR_ROOTS, FLOW_ROOTS, checkV4Expr, parsePath } from './expr'

// ---------------------------------------------------------------------------
// 语法错误：可读中文 + 行列号（与 v3 ScriptError 口径一致）
// ---------------------------------------------------------------------------

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col: number,
  ) {
    super(`第 ${line} 行第 ${col} 列: ${message}`)
    this.name = 'ScriptError'
  }
}

const INDENT = '  '
const LOCAL_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/
const COMPONENT_EVENT = /^(?:start|internal\.[A-Za-z_][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*)$/
const INTERNAL_EVENT = /^internal\.[A-Za-z_][A-Za-z0-9_-]*$/
const CALL_TEXT = /^([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/
const ASSIGN_TEXT = /^([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*){1,2})\s*=\s*(.+)$/

type Layer = 'flow' | 'behavior'

function indentLines(lines: string[]): string[] {
  return lines.map((line) => (line === '' ? line : `${INDENT}${line}`))
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

function literalText(value: Json): string {
  return JSON.stringify(value) ?? 'null'
}

function checkExprText(src: string, layer: Layer, where: string, line: number): void {
  const text = src.trim()
  if (text === '') throw new ScriptError(`${where}不能为空`, line, 1)
  const checked = checkV4Expr(text, {
    roots: layer === 'flow' ? FLOW_ROOTS : BEHAVIOR_ROOTS,
    allowV4Functions: layer === 'flow',
  })
  if (!checked.ok) throw new ScriptError(`${where}：${checked.message}`, line, 1)
}

/** 校验「值表达式」可被伪代码原样写回（生成侧：IR 里的字段必须能落到文本） */
function requireText(value: string | undefined, what: string): string {
  if (value === undefined || value.trim() === '') {
    throw new Error(`节点字段「${what}」为空，伪代码无法表达（请在节点图/JSON 中补全）`)
  }
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error(`节点字段「${what}」含换行，伪代码只支持单行表达式`)
  }
  return value
}

function requireLocalId(value: string | undefined, what: string): string {
  if (value === undefined || !LOCAL_ID.test(value) || value.length > 64) {
    throw new Error(`节点字段「${what}」不是合法本地 id「${value ?? ''}」，伪代码无法表达`)
  }
  return value
}

function requireInternalEvent(event: string, what: string): string {
  if (!INTERNAL_EVENT.test(event)) {
    throw new Error(`节点字段「${what}」不是 internal.<名字> 形式（当前「${event}」），伪代码无法表达`)
  }
  return event
}

/**
 * 生成前的字段可表达性检查：IR 里的必填字段必须能落到单行伪代码文本。
 * （图语言自由——字段缺失/非法时回退到节点图编辑，而不是生成一份无法解析的文本。）
 */
function ensureGeneratable(node: FlowNode | BehaviorNode, layer: Layer): void {
  if (node.kind === 'assign') {
    const target = requireText(node.target, '赋值目标')
    try {
      const parsed = parsePath(target)
      if (layer === 'flow' && parsed.root !== 'v' && parsed.root !== 'local') {
        throw new Error('流程层只能写 v.* / local.*')
      }
      if (layer === 'behavior' && parsed.root !== 'q' && parsed.root !== 't' && parsed.root !== 'local') {
        throw new Error('行为层只能写 q.state.* / t.* / local.*')
      }
      if (parsed.root === 'q' && (parsed.rest.length !== 2 || parsed.rest[0] !== 'state')) {
        throw new Error('行为层只能写 q.state.<字段>')
      }
    } catch (err) {
      throw new Error(`节点「${node.id}」赋值目标非法：${err instanceof Error ? err.message : String(err)}`)
    }
    if ('expr' in node.value) requireText(node.value.expr, '赋值表达式')
    else {
      requireLocalId(node.value.query.target, '查询目标')
      requireLocalId(node.value.query.method, '查询方法')
      if (node.value.query.arg !== undefined) requireText(node.value.query.arg, '查询参数')
    }
  } else if (node.kind === 'call') {
    requireLocalId(node.target, '命令目标')
    requireLocalId(node.method, '命令方法')
    if (node.arg !== undefined && node.arg.trim() !== '') requireText(node.arg, 'call 参数')
  } else if (node.kind === 'setView') {
    requireLocalId(node.view, '目标视图')
  } else if (node.kind === 'ask') {
    requireText(node.target, 'ask target')
    requireLocalId(node.resultVar, 'ask 结果变量')
    if (node.args !== undefined && node.args.trim() !== '') requireText(node.args, 'ask args')
  } else if (node.kind === 'foreach') {
    requireText(node.items, 'foreach 遍历表达式')
    requireLocalId(node.itemVar, 'foreach 元素变量')
    if (node.indexVar !== undefined) requireLocalId(node.indexVar, 'foreach 下标变量')
  } else if (node.kind === 'branch') {
    requireText(node.cond, '分支条件')
  } else if (node.kind === 'loop') {
    if (node.mode === 'while') requireText(node.cond, 'while 条件')
    else requireText(node.times, 'repeat 次数')
  } else if (node.kind === 'wait') {
    requireText(node.ms, '等待毫秒表达式')
  } else if (node.kind === 'waitShell') {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/.test(node.event)) {
      throw new Error(`节点「${node.id}」的 waitShell 事件「${node.event}」非法（应为 <shell组件id>.<事件名>）`)
    }
  } else if (node.kind === 'finish') {
    if (node.passed !== undefined) requireText(node.passed, 'finish passed 表达式')
  } else if (node.kind === 'on') {
    if (!COMPONENT_EVENT.test(node.event)) {
      throw new Error(`节点「${node.id}」的 on 事件「${node.event}」非法（应为 start / internal.<名字> / <组件id>.<事件名>）`)
    }
  } else if (node.kind === 'return') {
    requireText(node.result, 'return 返回值')
  } else if (node.kind === 'emit') {
    requireInternalEvent(node.event, 'emit 事件')
    for (const [key, expr] of Object.entries(node.payload ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`节点「${node.id}」的 emit 负载键「${key}」非法`)
      requireText(expr, `emit 负载 "${key}"`)
    }
  }
}

// ---------------------------------------------------------------------------
// 节点文本（生成器与锚点合并共用的「语句特征」）
// ---------------------------------------------------------------------------

/** RValue 的单行文本：表达式原样；查询调用 `target.method(arg)`（arg 缺省 `()`） */
export function rvalueTextScript(value: RValue): string {
  if ('expr' in value) return value.expr
  const query = value.query
  return `${query.target}.${query.method}(${query.arg ?? ''})`
}

function emitText(node: Extract<BehaviorNode, { kind: 'emit' }>): string {
  const entries = Object.entries(node.payload ?? {})
  const payload = node.payload === undefined ? '' : ` {${entries.map(([key, expr]) => `${key}: ${expr}`).join(', ')}}`
  return `emit ${JSON.stringify(node.event)}${payload}`
}

/**
 * 节点的单行语句文本（无缩进）：同一文本 ≈ 同一语句——生成器行文本与锚点合并的
 * 「语句特征串」都用它，保证配对口径一致。
 *
 * 说明：分支/循环/foreach/on 返回**块头**（不带 `{`），其块体由生成器渲染/解析器重建。
 */
export function nodeScriptText(node: FlowNode | BehaviorNode): string {
  switch (node.kind) {
    case 'start':
      return 'start'
    case 'on':
      return `on ${node.event}`
    case 'return':
      return `return ${node.result}`
    case 'emit':
      return emitText(node)
    case 'assign':
      return `${node.target} = ${rvalueTextScript(node.value)}`
    case 'call':
      return `call ${node.target}.${node.method}(${node.arg ?? ''})`
    case 'setView':
      return `view ${node.view}`
    case 'ask':
      return `ask ${node.target}${node.args !== undefined ? ` with ${node.args}` : ''} -> ${node.resultVar}`
    case 'foreach':
      return `foreach ${node.itemVar}${node.indexVar !== undefined ? `, ${node.indexVar}` : ''} in ${node.items}`
    case 'branch':
      return `if (${node.cond})`
    case 'loop':
      return node.mode === 'while' ? `while (${node.cond ?? ''})` : `repeat (${node.times ?? ''})`
    case 'wait':
      return `wait ${node.ms}`
    case 'waitShell':
      return `waitShell ${node.event}`
    case 'finish':
      return node.passed !== undefined ? `finish passed: ${node.passed}` : 'finish'
    case 'restart':
      return 'restart'
    case 'comment':
      return `// ${oneLine(node.text)}`
  }
}

// ---------------------------------------------------------------------------
// 生成器：IR → 文本
// ---------------------------------------------------------------------------

interface OutIndex {
  nodes: Map<string, FlowNode | BehaviorNode>
  /** 单出口边：from → to（port 缺省） */
  single: Map<string, string>
  /** true 端口（branch/loop/foreach 的体/真分支） */
  truePort: Map<string, string>
  /** false 端口（branch/loop/foreach 的出口/假分支） */
  falsePort: Map<string, string>
  /** 入边计数（start/on 入口约束检查） */
  incoming: Map<string, number>
}

function buildOutIndex(program: { nodes: (FlowNode | BehaviorNode)[]; edges: GraphEdge[] }): OutIndex {
  const idx: OutIndex = {
    nodes: new Map(program.nodes.map((node) => [node.id, node])),
    single: new Map(),
    truePort: new Map(),
    falsePort: new Map(),
    incoming: new Map(),
  }
  for (const edge of program.edges) {
    if (!idx.nodes.has(edge.from) || !idx.nodes.has(edge.to)) {
      throw new Error(`连线「${edge.id}」端点不存在（${edge.from} → ${edge.to}），伪代码无法生成`)
    }
    const fromNode = idx.nodes.get(edge.from) as FlowNode | BehaviorNode
    const toNode = idx.nodes.get(edge.to) as FlowNode | BehaviorNode
    if (fromNode.kind === 'comment' || toNode.kind === 'comment') {
      throw new Error(`连线「${edge.id}」连接了注释节点（注释不参与执行），伪代码无法生成`)
    }
    if (fromNode.kind === 'return' || fromNode.kind === 'restart') {
      throw new Error(`节点「${fromNode.id}」是结束点（${fromNode.kind}），不能有出边，伪代码无法生成`)
    }
    if (fromNode.kind === 'start' || fromNode.kind === 'on') {
      if (edge.port !== undefined) throw new Error(`入口节点「${fromNode.id}」只能有单出口边，伪代码无法生成`)
    }
    const bucket = edge.port === 'true' ? idx.truePort : edge.port === 'false' ? idx.falsePort : idx.single
    if (bucket.has(edge.from)) {
      throw new Error(
        `节点「${edge.from}」的 ${edge.port === undefined ? '单' : edge.port} 出口有多条连线，伪代码无法表达（请先在节点图删掉多余连线）`,
      )
    }
    bucket.set(edge.from, edge.to)
    idx.incoming.set(edge.to, (idx.incoming.get(edge.to) ?? 0) + 1)
  }
  for (const node of program.nodes) {
    if (node.kind === 'comment' && idx.incoming.has(node.id)) {
      throw new Error(`注释节点「${node.id}」不能有入边，伪代码无法生成`)
    }
    if ((node.kind === 'start' || node.kind === 'on') && idx.incoming.has(node.id)) {
      throw new Error(`入口节点「${node.id}」不能有入边，伪代码无法生成`)
    }
  }
  return idx
}

/** BFS 可达距离表（沿执行边；双出口两边都走） */
function bfsDistances(idx: OutIndex, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]])
  const queue = [start]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    const node = idx.nodes.get(cur)
    if (!node) continue
    const nexts: string[] = []
    const single = idx.single.get(cur)
    if (single !== undefined) nexts.push(single)
    const t = idx.truePort.get(cur)
    const f = idx.falsePort.get(cur)
    if (t !== undefined) nexts.push(t)
    if (f !== undefined) nexts.push(f)
    for (const next of nexts) {
      if (!dist.has(next)) {
        dist.set(next, (dist.get(cur) as number) + 1)
        queue.push(next)
      }
    }
  }
  return dist
}

/**
 * 双出口节点的结构化汇合点：true/false 两支都可达的节点中 BFS 距离和最小者。
 * 无公共后继（任一支掉出）返回 null。启发式与 v3 口径一致。
 */
function joinOf(idx: OutIndex, branchId: string): string | null {
  const t = idx.truePort.get(branchId)
  const f = idx.falsePort.get(branchId)
  if (t === undefined || f === undefined) return null
  const distT = bfsDistances(idx, t)
  const distF = bfsDistances(idx, f)
  let best: string | null = null
  let bestSum = Number.POSITIVE_INFINITY
  for (const [nodeId, d1] of distT) {
    const d2 = distF.get(nodeId)
    if (d2 !== undefined && d1 + d2 < bestSum) {
      best = nodeId
      bestSum = d1 + d2
    }
  }
  return best
}

interface ChainOpts {
  /** 到达即停（汇合点，由外层顺序链消费） */
  stopAt?: string | null
  /** 当前循环头：体遍历再次到达它 = 回边 */
  loopHead?: string | null
  /** 循环体禁止到达的节点（循环出口 = 提前跳出，伪代码不表达） */
  forbid?: Set<string>
}

interface ChainResult {
  lines: string[]
  /** 体链回到了循环头（回边） */
  returned: boolean
  /** 链止于终止节点（restart / return），不是自然掉出 */
  terminated: boolean
}

function multiMergeError(nodeId: string): Error {
  return new Error(`节点「${nodeId}」被多条路径汇入，伪代码无法表达（请简化图结构或改用节点图编辑）`)
}

function lookupNode(idx: OutIndex, nodeId: string): FlowNode | BehaviorNode {
  const node = idx.nodes.get(nodeId)
  if (!node) throw new Error(`节点「${nodeId}」不存在（悬空边），伪代码无法生成`)
  return node
}

// ---------------------------------------------------------------------------
// 生成器 · Flow main
// ---------------------------------------------------------------------------

function generateFlowChain(
  idx: OutIndex,
  from: string | undefined,
  visited: Set<string>,
  opts: ChainOpts = {},
): ChainResult {
  const lines: string[] = []
  let cur = from
  while (cur !== undefined) {
    if (opts.stopAt !== undefined && opts.stopAt !== null && cur === opts.stopAt) {
      return { lines, returned: false, terminated: false }
    }
    if (opts.loopHead !== undefined && opts.loopHead !== null && cur === opts.loopHead) {
      return { lines, returned: true, terminated: false }
    }
    if (opts.forbid?.has(cur)) {
      throw new Error(`伪代码无法表达从循环体直接跳出到节点「${cur}」（请用 branch 包裹提前结束，或改用节点图编辑）`)
    }
    if (visited.has(cur)) throw multiMergeError(cur)
    visited.add(cur)
    const node = lookupNode(idx, cur)
    ensureGeneratable(node, 'flow')
    switch (node.kind) {
      case 'start':
        throw new Error(`start 节点「${node.id}」不能有入边/不能顺序执行到`)
      case 'comment':
        throw new Error(`注释节点「${node.id}」不能接线（注释不参与执行），伪代码无法表达`)
      case 'on':
      case 'return':
      case 'emit':
        throw new Error(`流程层不支持「${node.kind}」节点（行为层专属）`)
      case 'assign':
      case 'call':
      case 'setView':
      case 'wait':
      case 'waitShell':
      case 'finish':
      case 'ask': {
        lines.push(nodeScriptText(node))
        cur = idx.single.get(node.id)
        break
      }
      case 'restart': {
        lines.push(nodeScriptText(node))
        if (idx.single.has(node.id)) throw new Error(`restart 节点「${node.id}」是结束点，不能再有后续节点`)
        return { lines, returned: false, terminated: true }
      }
      case 'branch': {
        const join = joinOf(idx, node.id)
        lines.push(...renderFlowIf(idx, node, join, visited, opts))
        cur = join ?? undefined
        break
      }
      case 'loop':
      case 'foreach': {
        const dual = node
        const body = idx.truePort.get(dual.id)
        if (body === undefined) {
          throw new Error(`循环节点「${dual.id}」没有循环体（true 出口未接线），伪代码无法表达`)
        }
        const exit = idx.falsePort.get(dual.id)
        const forbid = new Set<string>()
        if (exit !== undefined) forbid.add(exit)
        const bodyRes = generateFlowChain(idx, body, visited, { loopHead: dual.id, forbid })
        if (!bodyRes.returned && !bodyRes.terminated) {
          throw new Error(
            `伪代码无法表达循环节点「${dual.id}」的循环体：体末尾必须回到循环头（如需提前结束请用 branch 包裹，或改用节点图编辑）`,
          )
        }
        const open = nodeScriptText(dual)
        lines.push(`${open} {`, ...indentLines(bodyRes.lines), '}')
        cur = exit
        break
      }
    }
  }
  return { lines, returned: false, terminated: false }
}

function renderFlowIf(
  idx: OutIndex,
  branch: Extract<FlowNode, { kind: 'branch' }>,
  join: string | null,
  visited: Set<string>,
  opts: ChainOpts,
): string[] {
  const thenStart = idx.truePort.get(branch.id)
  const elseStart = idx.falsePort.get(branch.id)
  if (join !== null) {
    const thenBody = thenStart !== undefined ? generateFlowChain(idx, thenStart, visited, { ...opts, stopAt: join }).lines : []
    const lines = [`if (${branch.cond}) {`, ...indentLines(thenBody), '}']
    if (elseStart !== undefined && elseStart !== join) {
      const elseNode = lookupNode(idx, elseStart)
      if (elseNode.kind === 'branch' && joinOf(idx, elseStart) === join) {
        const inner = renderFlowIf(idx, elseNode as Extract<FlowNode, { kind: 'branch' }>, join, visited, opts)
        lines[lines.length - 1] = `} else ${inner[0]}`
        lines.push(...inner.slice(1))
      } else {
        const elseBody = generateFlowChain(idx, elseStart, visited, { ...opts, stopAt: join }).lines
        lines[lines.length - 1] = '} else {'
        lines.push(...indentLines(elseBody), '}')
      }
    }
    return lines
  }
  // 无公共汇合点：两支各自跑到自然结束（另一支掉出 = 结束），文本上就是 if/else 收尾
  const thenBody = thenStart !== undefined ? generateFlowChain(idx, thenStart, visited, { ...opts, stopAt: null }).lines : []
  const lines = [`if (${branch.cond}) {`, ...indentLines(thenBody), '}']
  if (elseStart !== undefined) {
    const elseBody = generateFlowChain(idx, elseStart, visited, { ...opts, stopAt: null }).lines
    lines[lines.length - 1] = '} else {'
    lines.push(...indentLines(elseBody), '}')
  }
  return lines
}

function collectComments(nodes: (FlowNode | BehaviorNode)[]): string[] {
  return nodes.filter((node) => node.kind === 'comment').map((node) => nodeScriptText(node))
}

/** 生成 Flow main 伪代码（含 vars 声明块；没有 vars 时省略该块） */
export function generateFlowScript(program: FlowProgram): string {
  const idx = buildOutIndex(program)
  const chunks: string[] = []
  const vars = program.vars ?? []
  if (vars.length > 0) {
    const block = ['vars {']
    for (const field of vars) {
      if (!LOCAL_ID.test(field.key)) throw new Error(`变量名「${field.key}」不是合法本地 id，伪代码无法表达`)
      block.push(`${INDENT}v.${field.key}: ${field.type} = ${literalText(field.init)}`)
    }
    block.push('}')
    chunks.push(block.join('\n'))
  }
  const starts = program.nodes.filter((node) => node.kind === 'start')
  if (starts.length !== 1) throw new Error(`流程主图必须且只能有一个 start 节点（当前 ${starts.length} 个），伪代码无法生成`)
  const start = starts[0]
  if (idx.incoming.has(start.id)) throw new Error(`start 节点「${start.id}」不能有入边，伪代码无法生成`)
  const visited = new Set<string>()
  const body = generateFlowChain(idx, idx.single.get(start.id), visited)
  const lines = ['main {']
  for (const comment of collectComments(program.nodes)) lines.push(`${INDENT}${comment}`)
  lines.push(...indentLines(body.lines))
  lines.push('}')
  chunks.push(lines.join('\n'))
  return `${chunks.join('\n\n')}\n`
}

// ---------------------------------------------------------------------------
// 生成器 · Behavior
// ---------------------------------------------------------------------------

function generateBehaviorChain(
  idx: OutIndex,
  from: string | undefined,
  visited: Set<string>,
  opts: ChainOpts = {},
): ChainResult {
  const lines: string[] = []
  let cur = from
  while (cur !== undefined) {
    if (opts.stopAt !== undefined && opts.stopAt !== null && cur === opts.stopAt) {
      return { lines, returned: false, terminated: false }
    }
    if (opts.loopHead !== undefined && opts.loopHead !== null && cur === opts.loopHead) {
      return { lines, returned: true, terminated: false }
    }
    if (opts.forbid?.has(cur)) {
      throw new Error(`伪代码无法表达从循环体直接跳出到节点「${cur}」（请用 branch 包裹提前结束，或改用节点图编辑）`)
    }
    if (visited.has(cur)) throw multiMergeError(cur)
    visited.add(cur)
    const node = lookupNode(idx, cur)
    ensureGeneratable(node, 'behavior')
    switch (node.kind) {
      case 'on':
        throw new Error(`on 节点「${node.id}」不能有入边/不能顺序执行到`)
      case 'comment':
        throw new Error(`注释节点「${node.id}」不能接线（注释不参与执行），伪代码无法表达`)
      case 'start':
      case 'ask':
      case 'foreach':
      case 'waitShell':
      case 'finish':
      case 'restart':
        throw new Error(`行为层不支持「${node.kind}」节点（流程层专属）`)
      case 'assign':
      case 'call':
      case 'emit':
      case 'setView':
      case 'wait': {
        lines.push(nodeScriptText(node))
        cur = idx.single.get(node.id)
        break
      }
      case 'return': {
        lines.push(nodeScriptText(node))
        if (idx.single.has(node.id)) throw new Error(`return 节点「${node.id}」是结束点，不能再有后续节点`)
        return { lines, returned: false, terminated: true }
      }
      case 'branch': {
        const join = joinOf(idx, node.id)
        lines.push(...renderBehaviorIf(idx, node, join, visited, opts))
        cur = join ?? undefined
        break
      }
      case 'loop': {
        const body = idx.truePort.get(node.id)
        if (body === undefined) throw new Error(`循环节点「${node.id}」没有循环体（true 出口未接线），伪代码无法表达`)
        const exit = idx.falsePort.get(node.id)
        const forbid = new Set<string>()
        if (exit !== undefined) forbid.add(exit)
        const bodyRes = generateBehaviorChain(idx, body, visited, { loopHead: node.id, forbid })
        if (!bodyRes.returned && !bodyRes.terminated) {
          throw new Error(
            `伪代码无法表达循环节点「${node.id}」的循环体：体末尾必须回到循环头（如需提前结束请用 return/branch，或改用节点图编辑）`,
          )
        }
        lines.push(`${nodeScriptText(node)} {`, ...indentLines(bodyRes.lines), '}')
        cur = exit
        break
      }
    }
  }
  return { lines, returned: false, terminated: false }
}

function renderBehaviorIf(
  idx: OutIndex,
  branch: Extract<BehaviorNode, { kind: 'branch' }>,
  join: string | null,
  visited: Set<string>,
  opts: ChainOpts,
): string[] {
  const thenStart = idx.truePort.get(branch.id)
  const elseStart = idx.falsePort.get(branch.id)
  if (join !== null) {
    const thenBody = thenStart !== undefined ? generateBehaviorChain(idx, thenStart, visited, { ...opts, stopAt: join }).lines : []
    const lines = [`if (${branch.cond}) {`, ...indentLines(thenBody), '}']
    if (elseStart !== undefined && elseStart !== join) {
      const elseNode = lookupNode(idx, elseStart)
      if (elseNode.kind === 'branch' && joinOf(idx, elseStart) === join) {
        const inner = renderBehaviorIf(idx, elseNode as Extract<BehaviorNode, { kind: 'branch' }>, join, visited, opts)
        lines[lines.length - 1] = `} else ${inner[0]}`
        lines.push(...inner.slice(1))
      } else {
        const elseBody = generateBehaviorChain(idx, elseStart, visited, { ...opts, stopAt: join }).lines
        lines[lines.length - 1] = '} else {'
        lines.push(...indentLines(elseBody), '}')
      }
    }
    return lines
  }
  const thenBody = thenStart !== undefined ? generateBehaviorChain(idx, thenStart, visited, { ...opts, stopAt: null }).lines : []
  const lines = [`if (${branch.cond}) {`, ...indentLines(thenBody), '}']
  if (elseStart !== undefined) {
    const elseBody = generateBehaviorChain(idx, elseStart, visited, { ...opts, stopAt: null }).lines
    lines[lines.length - 1] = '} else {'
    lines.push(...indentLines(elseBody), '}')
  }
  return lines
}

/** 生成 Behavior 伪代码（含 locals 声明块；没有 locals 时省略该块） */
export function generateBehaviorScript(program: BehaviorProgram): string {
  const idx = buildOutIndex(program)
  const chunks: string[] = []
  const locals = program.locals ?? []
  if (locals.length > 0) {
    const block = ['locals {']
    for (const field of locals) {
      if (!LOCAL_ID.test(field.key)) throw new Error(`局部变量名「${field.key}」不是合法本地 id，伪代码无法表达`)
      block.push(`${INDENT}local.${field.key}: ${field.type} = ${literalText(field.init)}`)
    }
    block.push('}')
    chunks.push(block.join('\n'))
  }
  const comments = collectComments(program.nodes)
  if (comments.length > 0) chunks.push(comments.join('\n'))
  const handlers = program.nodes.filter((node): node is Extract<BehaviorNode, { kind: 'on' }> => node.kind === 'on')
  if (handlers.length === 0) throw new Error('行为图没有 on 事件入口，伪代码无法生成')
  for (const on of handlers) {
    ensureGeneratable(on, 'behavior')
    if (idx.incoming.has(on.id)) throw new Error(`on 节点「${on.id}」不能有入边，伪代码无法生成`)
    const visited = new Set<string>([on.id])
    const body = generateBehaviorChain(idx, idx.single.get(on.id), visited)
    const lines = [`on ${on.event} {`, ...indentLines(body.lines), '}']
    chunks.push(lines.join('\n'))
  }
  return `${chunks.join('\n\n')}\n`
}

// ---------------------------------------------------------------------------
// 解析器 · 公共工具
// ---------------------------------------------------------------------------

interface SourceLine {
  text: string
  no: number
}

interface Tail {
  from: string
  port?: 'true' | 'false'
}

type Stmt =
  | { t: 'comment'; text: string; line: number }
  | { t: 'assign'; target: string; value: RValue; line: number }
  | { t: 'call'; target: string; method: string; arg?: string; line: number }
  | { t: 'setView'; view: string; line: number }
  | { t: 'ask'; target: string; args?: string; resultVar: string; line: number }
  | { t: 'foreach'; itemVar: string; indexVar?: string; items: string; body: Stmt[]; line: number }
  | { t: 'branch'; cond: string; then: Stmt[]; else_: Stmt[] | null; line: number }
  | { t: 'loop'; mode: 'while' | 'repeat'; cond?: string; times?: string; body: Stmt[]; line: number }
  | { t: 'wait'; ms: string; line: number }
  | { t: 'waitShell'; event: string; line: number }
  | { t: 'finish'; passed?: string; line: number }
  | { t: 'restart'; line: number }
  | { t: 'on'; event: string; body: Stmt[]; line: number }
  | { t: 'return'; result: string; line: number }
  | { t: 'emit'; event: string; payload?: Record<string, string>; line: number }

interface BlockEnd {
  kind: 'close' | 'else' | 'elseIf'
  /** elseIf 的条件（kind === 'elseIf'） */
  cond?: string
  line: number
}

/** 在顶层（引号外、括号深度 0）按分隔串切分 */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i))
      i += separator.length - 1
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** 顶层第一个 ':' 的下标（对象字面量的键值分隔），找不到返回 -1 */
function topLevelColon(text: string): number {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1
    else if (depth === 0 && ch === ':') return i
  }
  return -1
}

function parseJsonLiteral(src: string, line: number, what: string): Json {
  const text = src.trim()
  if (text === '') throw new ScriptError(`${what}不能为空`, line, 1)
  try {
    return JSON.parse(text) as Json
  } catch {
    throw new ScriptError(`${what}必须是 JSON 字面量（数字/字符串/布尔/null/数组/对象）：「${text}」`, line, 1)
  }
}

function checkComponentEvent(event: string, line: number, what: string): void {
  if (!COMPONENT_EVENT.test(event)) {
    throw new ScriptError(
      `${what}「${event}」非法（可用：start / internal.<名字> / <组件id>.<事件名>）`,
      line,
      1,
    )
  }
}

function rootAllowed(layer: Layer, root: string): boolean {
  if (layer === 'flow') return root === 'v' || root === 'local'
  return root === 'q' || root === 't' || root === 'local'
}

/** 解析赋值目标：路径形态 + 层级写权限根（声明项由 lint 校验） */
function parseAssignTarget(target: string, layer: Layer, line: number): string {
  let parsed: ReturnType<typeof parsePath>
  try {
    parsed = parsePath(target)
  } catch (err) {
    throw new ScriptError(`赋值目标「${target}」非法：${err instanceof Error ? err.message : String(err)}`, line, 1)
  }
  const allowed =
    parsed.root === 'q' ? parsed.rest.length === 2 && parsed.rest[0] === 'state' : true
  if (layer === 'behavior' && parsed.root === 'q' && !allowed) {
    throw new ScriptError(`赋值目标「${target}」非法：行为层只能写 q.state.<字段>`, line, 1)
  }
  if (!rootAllowed(layer, parsed.root)) {
    const hint = layer === 'flow' ? '流程层只能写 v.* / local.*' : '行为层只能写 q.state.* / t.* / local.*'
    throw new ScriptError(`赋值目标「${target}」非法：${hint}`, line, 1)
  }
  return target
}

// ---------------------------------------------------------------------------
// 解析器 · 语句/块
// ---------------------------------------------------------------------------

class ScriptParser {
  private pos = 0
  private nodeCount = 0
  private edgeCount = 0
  private nodes: (FlowNode | BehaviorNode)[] = []
  private edges: GraphEdge[] = []

  constructor(
    private readonly lines: SourceLine[],
    private readonly layer: Layer,
    private readonly idPrefix: string,
  ) {}

  // ----- id -----

  private newNodeId(): string {
    this.nodeCount += 1
    return `${this.idPrefix}${this.nodeCount}`
  }

  private newEdgeId(): string {
    this.edgeCount += 1
    return `${this.idPrefix}e${this.edgeCount}`
  }

  // ----- 行游标 -----

  private peek(): SourceLine | undefined {
    return this.lines[this.pos]
  }

  private errorAt(line: SourceLine | undefined, message: string): ScriptError {
    if (!line) throw new ScriptError(message, 1, 1)
    return new ScriptError(message, line.no, 1)
  }

  private expectBlockOpen(opener: string, line: SourceLine): void {
    if (line.text !== `${opener} {`) {
      throw this.errorAt(line, `此处应为「${opener} {」，得到「${line.text}」`)
    }
    this.pos += 1
  }

  // ----- 顶层 -----

  /** 解析 flow 脚本：可选 vars 块 + main 块 */
  parseFlow(): FlowProgram {
    let vars: StateFieldDef[] | undefined
    const first = this.peek()
    if (first && first.text === 'vars {') {
      this.pos += 1
      vars = this.parseStateFieldsBlock('flow')
    }
    const main = this.peek()
    if (!main) throw this.errorAt(undefined, '脚本为空：缺少 main { ... } 主流程块')
    this.expectBlockOpen('main', main)
    const body = this.parseBlock(main)
    if (body.kind !== 'close') throw this.errorAt(this.peek(), 'main 块后不应出现 else')
    const rest = this.peek()
    if (rest) throw this.errorAt(rest, `main 块之后还有内容「${rest.text}」（伪代码只允许一个 main 块）`)

    const start: FlowNode = { id: this.newNodeId(), kind: 'start' }
    this.nodes.push(start)
    const lowered = this.lowerList(body.stmts)
    if (lowered.entry !== null) this.addEdge(start.id, lowered.entry)
    const program: FlowProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'flow',
      nodes: this.nodes as FlowNode[],
      edges: this.edges,
    }
    if (vars !== undefined) program.vars = vars
    return program
  }

  /** 解析 behavior 脚本：可选 locals 块 + 若干 on 事件块 + 顶层注释 */
  parseBehavior(): BehaviorProgram {
    let locals: StateFieldDef[] | undefined
    const first = this.peek()
    if (first && first.text === 'locals {') {
      this.pos += 1
      locals = this.parseStateFieldsBlock('behavior')
    }
    const handlers: { on: Extract<Stmt, { t: 'on' }> }[] = []
    const comments: Extract<Stmt, { t: 'comment' }>[] = []
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos] as SourceLine
      if (line.text.startsWith('//')) {
        comments.push({ t: 'comment', text: line.text.slice(2).trim(), line: line.no })
        this.pos += 1
        continue
      }
      const onMatch = /^on\s+(.+?)\s*\{$/.exec(line.text)
      if (!onMatch) {
        throw this.errorAt(line, `无法识别的内容「${line.text}」（行为伪代码只允许 locals 块 / on 事件块 / 注释）`)
      }
      this.pos += 1
      const event = onMatch[1].trim()
      checkComponentEvent(event, line.no, 'on 事件')
      const block = this.parseBlock(line)
      if (block.kind !== 'close') throw this.errorAt(this.peek(), 'on 块后不应出现 else')
      handlers.push({ on: { t: 'on', event, body: block.stmts, line: line.no } })
    }
    if (handlers.length === 0) throw this.errorAt(undefined, '行为伪代码缺少 on 事件块')
    // 节点顺序：注释（脚本顶部）→ 各 handler 的 on 与链节点
    for (const comment of comments) {
      this.nodes.push({ id: this.newNodeId(), kind: 'comment', text: comment.text })
    }
    for (const handler of handlers) {
      const on: BehaviorNode = { id: this.newNodeId(), kind: 'on', event: handler.on.event }
      this.nodes.push(on)
      const lowered = this.lowerList(handler.on.body)
      if (lowered.entry !== null) this.addEdge(on.id, lowered.entry)
    }
    const program: BehaviorProgram = {
      logicVersion: LOGIC_VERSION_V4,
      kind: 'behavior',
      nodes: this.nodes as BehaviorNode[],
      edges: this.edges,
    }
    if (locals !== undefined) program.locals = locals
    return program
  }

  /** vars/locals 块：`v.name: number = 0` / `local.name: json = null` */
  private parseStateFieldsBlock(owner: Layer): StateFieldDef[] {
    const prefix = owner === 'flow' ? 'v' : 'local'
    const fields: StateFieldDef[] = []
    for (;;) {
      const line = this.peek()
      if (!line) throw this.errorAt(undefined, `${owner === 'flow' ? 'vars' : 'locals'} 块缺少配对的 "}"`)
      if (line.text === '}') {
        this.pos += 1
        return fields
      }
      const match = new RegExp(`^${prefix}\\.([A-Za-z_][A-Za-z0-9_-]*):\\s*(number|boolean|string|json)\\s*=\\s*(.+)$`).exec(line.text)
      if (!match) {
        throw this.errorAt(
          line,
          `无法识别的声明「${line.text}」（应为 ${prefix}.<名字>: number|boolean|string|json = <JSON 初值>）`,
        )
      }
      fields.push({ key: match[1], type: match[2] as StateType, init: parseJsonLiteral(match[3], line.no, '变量初值') })
      this.pos += 1
    }
  }

  // ----- 块 -----

  /**
   * 解析 `{ ... }` 块体。
   * 返回的 kind：close = 正常 `}` 收尾；else = `} else {`；elseIf = `} else if (...) {`。
   */
  private parseBlock(openLine: SourceLine): BlockEnd & { stmts: Stmt[] } {
    const stmts: Stmt[] = []
    for (;;) {
      const line = this.peek()
      if (!line) {
        throw new ScriptError(`第 ${openLine.no} 行的代码块缺少配对的 "}"`, openLine.no, 1)
      }
      if (line.text === '}') {
        this.pos += 1
        return { kind: 'close', line: line.no, stmts }
      }
      if (line.text === '} else {') {
        this.pos += 1
        return { kind: 'else', line: line.no, stmts }
      }
      const elseIf = /^\}\s*else\s+if\s*\((.*)\)\s*\{$/.exec(line.text)
      if (elseIf) {
        this.pos += 1
        return { kind: 'elseIf', cond: elseIf[1].trim(), line: line.no, stmts }
      }
      stmts.push(this.parseStatement())
    }
  }

  // ----- 单条语句 -----

  private parseStatement(): Stmt {
    const line = this.peek() as SourceLine
    const text = line.text
    if (text.startsWith('//')) {
      this.pos += 1
      return { t: 'comment', text: text.slice(2).trim(), line: line.no }
    }
    if (/^if\s*\(/.test(text)) return this.parseIf(line)
    if (/^while\s*\(/.test(text)) return this.parseLoop(line, 'while')
    if (/^repeat\s*\(/.test(text)) return this.parseLoop(line, 'repeat')
    if (/^foreach\s+/.test(text)) return this.parseForeach(line)
    if (/^on\s+/.test(text)) {
      if (this.layer !== 'behavior') throw this.errorAt(line, '流程伪代码不支持 on 事件块（行为层专属）')
      throw this.errorAt(line, 'on 事件块必须位于行为脚本顶层（不能出现在其它块内）')
    }
    if (/^main\s*\{$/.test(text)) throw this.errorAt(line, 'main 块只能出现一次，且不能嵌套在其它块内')
    if (/^vars\s*\{$/.test(text) || /^locals\s*\{$/.test(text)) {
      throw this.errorAt(line, 'vars/locals 声明块必须位于脚本顶部')
    }
    if (text.startsWith('}')) throw this.errorAt(line, `多余的 "}"`)
    if (text.startsWith('return ')) {
      if (this.layer !== 'behavior') throw this.errorAt(line, '流程伪代码不支持 return（行为层专属）')
      this.pos += 1
      const result = text.slice('return '.length).trim()
      checkExprText(result, this.layer, 'return 返回值', line.no)
      return { t: 'return', result, line: line.no }
    }
    if (text.startsWith('emit ')) {
      if (this.layer !== 'behavior') throw this.errorAt(line, '流程伪代码不支持 emit（行为层专属）')
      return this.parseEmit(line)
    }
    if (text.startsWith('call ')) return this.parseCall(line)
    if (text.startsWith('ask ')) {
      if (this.layer !== 'behavior') return this.parseAsk(line)
      throw this.errorAt(line, '行为伪代码不支持 ask（流程层专属）')
    }
    if (text.startsWith('view ')) return this.parseSetView(line)
    if (text.startsWith('waitShell ')) {
      if (this.layer !== 'behavior') return this.parseWaitShell(line)
      throw this.errorAt(line, '行为伪代码不支持 waitShell（流程层专属）')
    }
    if (text === 'wait' || text.startsWith('wait ')) return this.parseWait(line)
    if (text === 'finish' || text.startsWith('finish ')) {
      if (this.layer !== 'behavior') return this.parseFinish(line)
      throw this.errorAt(line, '行为伪代码不支持 finish（流程层专属）')
    }
    if (text === 'restart') {
      if (this.layer !== 'behavior') {
        this.pos += 1
        return { t: 'restart', line: line.no }
      }
      throw this.errorAt(line, '行为伪代码不支持 restart（流程层专属）')
    }
    const assign = ASSIGN_TEXT.exec(text)
    if (assign) return this.parseAssign(line, assign[1], assign[2])
    throw this.errorAt(
      line,
      `无法识别的语句「${text}」（可用：赋值 / call / view / ask / while / repeat / foreach / if / wait / finish / restart / 注释）`,
    )
  }

  private parseAssign(line: SourceLine, targetText: string, valueText: string): Stmt {
    const target = parseAssignTarget(targetText.trim(), this.layer, line.no)
    const raw = valueText.trim()
    if (raw === '') throw this.errorAt(line, '赋值缺少右侧表达式')
    const call = CALL_TEXT.exec(raw)
    if (call) {
      const argText = call[3].trim()
      if (argText !== '') checkExprText(argText, this.layer, '查询参数', line.no)
      const query: { target: string; method: string; arg?: string } = { target: call[1], method: call[2] }
      if (argText !== '') query.arg = argText
      this.pos += 1
      return { t: 'assign', target, value: { query }, line: line.no }
    }
    checkExprText(raw, this.layer, '赋值表达式', line.no)
    this.pos += 1
    return { t: 'assign', target, value: { expr: raw }, line: line.no }
  }

  private parseCall(line: SourceLine): Stmt {
    const raw = line.text.slice('call '.length).trim()
    const call = CALL_TEXT.exec(raw)
    if (!call) throw this.errorAt(line, `call 语句应为 call <组件id>.<命令>(<参数对象>)：「${line.text}」`)
    const argText = call[3].trim()
    if (argText !== '') checkExprText(argText, this.layer, 'call 参数', line.no)
    this.pos += 1
    const stmt: Stmt = { t: 'call', target: call[1], method: call[2], line: line.no }
    if (argText !== '') stmt.arg = argText
    return stmt
  }

  private parseSetView(line: SourceLine): Stmt {
    const view = line.text.slice('view '.length).trim()
    if (!LOCAL_ID.test(view)) throw this.errorAt(line, `视图 id「${view}」非法（应为字母/下划线开头的本地 id）`)
    this.pos += 1
    return { t: 'setView', view, line: line.no }
  }

  private parseWait(line: SourceLine): Stmt {
    const ms = line.text === 'wait' ? '' : line.text.slice('wait '.length).trim()
    checkExprText(ms, this.layer, 'wait 毫秒表达式', line.no)
    this.pos += 1
    return { t: 'wait', ms, line: line.no }
  }

  private parseWaitShell(line: SourceLine): Stmt {
    const event = line.text.slice('waitShell '.length).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_-]*$/.test(event)) {
      throw this.errorAt(line, `waitShell 事件「${event}」非法（应为 <shell组件id>.<事件名>）`)
    }
    this.pos += 1
    return { t: 'waitShell', event, line: line.no }
  }

  private parseFinish(line: SourceLine): Stmt {
    const rest = line.text.slice('finish'.length).trim()
    if (rest === '') {
      this.pos += 1
      return { t: 'finish', line: line.no }
    }
    if (!rest.startsWith('passed:')) throw this.errorAt(line, `finish 语句只支持「finish」或「finish passed: <表达式>」：「${line.text}」`)
    const passed = rest.slice('passed:'.length).trim()
    checkExprText(passed, this.layer, 'finish passed 表达式', line.no)
    this.pos += 1
    return { t: 'finish', passed, line: line.no }
  }

  private parseAsk(line: SourceLine): Stmt {
    const raw = line.text.slice('ask '.length).trim()
    const arrow = raw.lastIndexOf('->')
    if (arrow < 0) throw this.errorAt(line, `ask 语句缺少 "-> <结果变量>"：「${line.text}」`)
    const targetPart = raw.slice(0, arrow).trim()
    const resultVar = raw.slice(arrow + 2).trim()
    if (!LOCAL_ID.test(resultVar)) throw this.errorAt(line, `ask 结果变量「${resultVar}」非法（应为合法本地 id）`)
    const withParts = splitTopLevel(targetPart, ' with ')
    const target = (withParts[0] ?? '').trim()
    const argText = withParts.length > 1 ? withParts.slice(1).join(' with ').trim() : ''
    checkExprText(target, this.layer, 'ask target 表达式', line.no)
    if (argText !== '') checkExprText(argText, this.layer, 'ask args 表达式', line.no)
    this.pos += 1
    const stmt: Stmt = { t: 'ask', target, resultVar, line: line.no }
    if (argText !== '') stmt.args = argText
    return stmt
  }

  private parseEmit(line: SourceLine): Stmt {
    const raw = line.text.slice('emit '.length).trim()
    const match = /^("(?:[^"\\]|\\.)*")(?:\s+(\{[\s\S]*\}))?$/.exec(raw)
    if (!match) throw this.errorAt(line, `emit 语句应为 emit "<事件名>" 或 emit "<事件名>" {负载}：「${line.text}」`)
    let event: string
    try {
      event = JSON.parse(match[1]) as string
    } catch {
      throw this.errorAt(line, `emit 事件名不是合法 JSON 字符串：${match[1]}`)
    }
    if (!INTERNAL_EVENT.test(event)) throw this.errorAt(line, `emit 事件「${event}」非法（必须是 internal.<名字>）`)
    let payload: Record<string, string> | undefined
    if (match[2] !== undefined) payload = this.parsePayloadObject(match[2], line)
    this.pos += 1
    const stmt: Stmt = { t: 'emit', event, line: line.no }
    if (payload !== undefined) stmt.payload = payload
    return stmt
  }

  private parsePayloadObject(text: string, line: SourceLine): Record<string, string> {
    const inner = text.trim().slice(1, -1).trim()
    const payload: Record<string, string> = {}
    if (inner === '') return payload
    for (const part of splitTopLevel(inner, ',')) {
      const colon = topLevelColon(part)
      if (colon < 0) throw this.errorAt(line, `emit 负载项「${part.trim()}」缺少 "键: 表达式"`)
      const key = part.slice(0, colon).trim()
      const valueSrc = part.slice(colon + 1).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw this.errorAt(line, `emit 负载键「${key}」非法（应为标识符）`)
      }
      checkExprText(valueSrc, this.layer, `emit 负载 "${key}"`, line.no)
      payload[key] = valueSrc
    }
    return payload
  }

  private parseIf(line: SourceLine): Stmt {
    const open = /^if\s*\((.*)\)\s*\{$/.exec(line.text)
    if (!open) throw this.errorAt(line, `if 语句应为 if (<条件>) {：「${line.text}」`)
    const cond = open[1].trim()
    checkExprText(cond, this.layer, 'if 条件', line.no)
    this.pos += 1
    const thenBlock = this.parseBlock(line)
    let elseBody: Stmt[] | null = null
    if (thenBlock.kind === 'else') {
      const elseBlock = this.parseBlock(line)
      if (elseBlock.kind !== 'close') throw this.errorAt(this.peek(), 'else 块后不应再出现 else')
      elseBody = elseBlock.stmts
    } else if (thenBlock.kind === 'elseIf') {
      const nested = this.parseIfFrom(line, thenBlock.cond ?? '')
      elseBody = [nested]
    }
    return { t: 'branch', cond, then: thenBlock.stmts, else_: elseBody, line: line.no }
  }

  /** 解析 `} else if (<cond>) {` 之后的块（复用一个 if 的 then/else 结构） */
  private parseIfFrom(line: SourceLine, cond: string): Stmt {
    checkExprText(cond, this.layer, 'if 条件', line.no)
    const thenBlock = this.parseBlock(line)
    let elseBody: Stmt[] | null = null
    if (thenBlock.kind === 'else') {
      const elseBlock = this.parseBlock(line)
      if (elseBlock.kind !== 'close') throw this.errorAt(this.peek(), 'else 块后不应再出现 else')
      elseBody = elseBlock.stmts
    } else if (thenBlock.kind === 'elseIf') {
      elseBody = [this.parseIfFrom(line, thenBlock.cond ?? '')]
    }
    return { t: 'branch', cond, then: thenBlock.stmts, else_: elseBody, line: line.no }
  }

  private parseLoop(line: SourceLine, mode: 'while' | 'repeat'): Stmt {
    const pattern = mode === 'while' ? /^while\s*\((.*)\)\s*\{$/ : /^repeat\s*\((.*)\)\s*\{$/
    const open = pattern.exec(line.text)
    if (!open) throw this.errorAt(line, `${mode} 语句应为 ${mode} (<表达式>) {：「${line.text}」`)
    const expr = open[1].trim()
    checkExprText(expr, this.layer, mode === 'while' ? 'while 条件' : 'repeat 次数', line.no)
    this.pos += 1
    const block = this.parseBlock(line)
    if (block.kind !== 'close') throw this.errorAt(this.peek(), `${mode} 块不能有 else`)
    if (block.stmts.filter((stmt) => stmt.t !== 'comment').length === 0) {
      throw this.errorAt(line, `${mode} 循环体不能为空`)
    }
    return mode === 'while'
      ? { t: 'loop', mode, cond: expr, body: block.stmts, line: line.no }
      : { t: 'loop', mode, times: expr, body: block.stmts, line: line.no }
  }

  private parseForeach(line: SourceLine): Stmt {
    const open = /^foreach\s+(.+?)\s+in\s+(.+)\s*\{$/.exec(line.text)
    if (!open) throw this.errorAt(line, `foreach 语句应为 foreach <变量>[, <下标变量>] in <表达式> {：「${line.text}」`)
    const spec = open[1].split(',').map((part) => part.trim())
    if (spec.length > 2) throw this.errorAt(line, `foreach 变量声明最多两项（元素, 下标）：「${open[1]}」`)
    const itemVar = spec[0] ?? ''
    const indexVar = spec[1]
    if (!LOCAL_ID.test(itemVar)) throw this.errorAt(line, `foreach 元素变量「${itemVar}」非法（应为合法本地 id）`)
    if (indexVar !== undefined && !LOCAL_ID.test(indexVar)) {
      throw this.errorAt(line, `foreach 下标变量「${indexVar}」非法（应为合法本地 id）`)
    }
    const items = open[2].trim()
    checkExprText(items, this.layer, 'foreach 遍历表达式', line.no)
    this.pos += 1
    const block = this.parseBlock(line)
    if (block.kind !== 'close') throw this.errorAt(this.peek(), 'foreach 块不能有 else')
    if (block.stmts.filter((stmt) => stmt.t !== 'comment').length === 0) {
      throw this.errorAt(line, 'foreach 循环体不能为空')
    }
    const stmt: Stmt = { t: 'foreach', itemVar, items, body: block.stmts, line: line.no }
    if (indexVar !== undefined) stmt.indexVar = indexVar
    return stmt
  }

  // ----- 语句 → IR（构边） -----

  private addEdge(from: string, to: string, port?: 'true' | 'false'): void {
    if (from === to) throw new ScriptError('伪代码解析出自我连线（内部错误），已阻止应用', 1, 1)
    const edge: GraphEdge = { id: this.newEdgeId(), from, to }
    if (port !== undefined) edge.port = port
    this.edges.push(edge)
  }

  private addCommentNode(stmt: Extract<Stmt, { t: 'comment' }>): void {
    this.nodes.push({ id: this.newNodeId(), kind: 'comment', text: stmt.text })
  }

  /**
   * 把一个语句块降级为节点链 + 边，返回块入口与「待接下游」的尾（branch 两支、循环出口）。
   * 注释不参与执行（v4 validate 禁止注释接线），只落节点、不影响 entry/tails。
   */
  private lowerList(stmts: Stmt[]): { entry: string | null; tails: Tail[] } {
    let entry: string | null = null
    let previousTails: Tail[] = []
    let terminalLine: number | null = null
    for (const stmt of stmts) {
      if (stmt.t === 'comment') {
        this.addCommentNode(stmt)
        continue
      }
      if (terminalLine !== null) {
        throw new ScriptError(`第 ${stmt.line} 行：上一语句是结束点（return/restart），之后不能再有语句`, stmt.line, 1)
      }
      const lowered = this.lowerStatement(stmt)
      const node = lowered.node
      if (!lowered.pushed) this.nodes.push(node)
      if (entry === null) entry = node.id
      for (const tail of previousTails) this.addEdge(tail.from, node.id, tail.port)
      previousTails = lowered.tails
      if (lowered.terminal) terminalLine = stmt.line
    }
    return { entry, tails: previousTails }
  }

  private lowerStatement(stmt: Exclude<Stmt, { t: 'comment' }>): {
    node: FlowNode | BehaviorNode
    tails: Tail[]
    terminal: boolean
    /** 节点是否已在 lowering 内部先入列（有子块的语句：节点必须在子节点之前） */
    pushed?: boolean
  } {
    switch (stmt.t) {
      case 'assign': {
        const node = { id: this.newNodeId(), kind: 'assign', target: stmt.target, value: stmt.value } as FlowNode
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'call': {
        const node = { id: this.newNodeId(), kind: 'call', target: stmt.target, method: stmt.method } as FlowNode
        if (stmt.arg !== undefined) (node as { arg?: string }).arg = stmt.arg
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'setView': {
        const node = { id: this.newNodeId(), kind: 'setView', view: stmt.view } as FlowNode
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'ask': {
        const node = { id: this.newNodeId(), kind: 'ask', target: stmt.target, resultVar: stmt.resultVar } as FlowNode
        if (stmt.args !== undefined) (node as { args?: string }).args = stmt.args
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'wait': {
        const node = { id: this.newNodeId(), kind: 'wait', ms: stmt.ms } as FlowNode
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'waitShell': {
        const node = { id: this.newNodeId(), kind: 'waitShell', event: stmt.event } as FlowNode
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'finish': {
        const node = { id: this.newNodeId(), kind: 'finish' } as FlowNode
        if (stmt.passed !== undefined) (node as { passed?: string }).passed = stmt.passed
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'restart': {
        const node = { id: this.newNodeId(), kind: 'restart' } as FlowNode
        return { node, tails: [], terminal: true }
      }
      case 'return': {
        const node = { id: this.newNodeId(), kind: 'return', result: stmt.result } as BehaviorNode
        return { node, tails: [], terminal: true }
      }
      case 'emit': {
        const node = { id: this.newNodeId(), kind: 'emit', event: stmt.event } as BehaviorNode
        if (stmt.payload !== undefined) (node as { payload?: Record<string, string> }).payload = stmt.payload
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'on': {
        const node = { id: this.newNodeId(), kind: 'on', event: stmt.event } as BehaviorNode
        return { node, tails: [{ from: node.id }], terminal: false }
      }
      case 'branch': {
        const node = { id: this.newNodeId(), kind: 'branch', cond: stmt.cond } as FlowNode
        this.nodes.push(node)
        const tails: Tail[] = []
        const thenLowered = this.lowerList(stmt.then)
        if (thenLowered.entry !== null) {
          this.addEdge(node.id, thenLowered.entry, 'true')
          tails.push(...thenLowered.tails)
        } else {
          tails.push({ from: node.id, port: 'true' })
        }
        if (stmt.else_ !== null) {
          const elseLowered = this.lowerList(stmt.else_)
          if (elseLowered.entry !== null) {
            this.addEdge(node.id, elseLowered.entry, 'false')
            tails.push(...elseLowered.tails)
          } else {
            tails.push({ from: node.id, port: 'false' })
          }
        } else {
          tails.push({ from: node.id, port: 'false' })
        }
        return { node, tails, terminal: false, pushed: true }
      }
      case 'loop': {
        const node =
          stmt.mode === 'while'
            ? ({ id: this.newNodeId(), kind: 'loop', mode: 'while', cond: stmt.cond ?? '' } as FlowNode)
            : ({ id: this.newNodeId(), kind: 'loop', mode: 'repeat', times: stmt.times ?? '' } as FlowNode)
        this.nodes.push(node)
        const bodyLowered = this.lowerList(stmt.body)
        if (bodyLowered.entry === null) throw new ScriptError(`第 ${stmt.line} 行：循环体不能为空`, stmt.line, 1)
        this.addEdge(node.id, bodyLowered.entry, 'true')
        for (const tail of bodyLowered.tails) this.addEdge(tail.from, node.id, tail.port)
        return { node, tails: [{ from: node.id, port: 'false' }], terminal: false, pushed: true }
      }
      case 'foreach': {
        const node = { id: this.newNodeId(), kind: 'foreach', items: stmt.items, itemVar: stmt.itemVar } as FlowNode
        if (stmt.indexVar !== undefined) (node as { indexVar?: string }).indexVar = stmt.indexVar
        this.nodes.push(node)
        const bodyLowered = this.lowerList(stmt.body)
        if (bodyLowered.entry === null) throw new ScriptError(`第 ${stmt.line} 行：foreach 循环体不能为空`, stmt.line, 1)
        this.addEdge(node.id, bodyLowered.entry, 'true')
        for (const tail of bodyLowered.tails) this.addEdge(tail.from, node.id, tail.port)
        return { node, tails: [{ from: node.id, port: 'false' }], terminal: false, pushed: true }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 解析入口
// ---------------------------------------------------------------------------

function prepareLines(text: string): SourceLine[] {
  const out: SourceLine[] = []
  text.split('\n').forEach((raw, index) => {
    const trimmedEnd = raw.replace(/\s+$/, '')
    if (trimmedEnd.trim() === '') return
    out.push({ text: trimmedEnd.trim(), no: index + 1 })
  })
  return out
}

export interface ParseScriptOptions {
  /** 解析产物的节点 id 前缀（默认 's'；锚点合并会把 id 改回旧图的稳定 id） */
  idPrefix?: string
}

/** 文本 → FlowProgram；语法错误抛 ScriptError（中文 + 行列号） */
export function parseFlowScript(text: string, options: ParseScriptOptions = {}): FlowProgram {
  const parser = new ScriptParser(prepareLines(text), 'flow', options.idPrefix ?? 's')
  return parser.parseFlow()
}

/** 文本 → BehaviorProgram；语法错误抛 ScriptError（中文 + 行列号） */
export function parseBehaviorScript(text: string, options: ParseScriptOptions = {}): BehaviorProgram {
  const parser = new ScriptParser(prepareLines(text), 'behavior', options.idPrefix ?? 's')
  return parser.parseBehavior()
}

// ---------------------------------------------------------------------------
// 锚点合并（二次编辑保留节点 id/x/y）
// ---------------------------------------------------------------------------

/**
 * 锚点合并结果：
 * - `kept`：与旧图语句配对成功、继承旧 id（旧节点有坐标时连同 x/y）的节点数；
 * - `unmatched`：新图中未找到旧语句配对的节点数（改写/新增语句 → 新 id、不继承坐标）；
 * - `dropped`：旧图中不可达（未接线）而非注释的节点数——应用脚本即丢弃。
 */
export interface ScriptMergeResult<T> {
  program: T
  kept: number
  unmatched: number
  dropped: number
}

interface MergeGraph<N> {
  nodes: N[]
  edges: GraphEdge[]
}

function graphNodeKey(layer: Layer, node: FlowNode | BehaviorNode): string {
  if (layer === 'flow' && (node.kind === 'on' || node.kind === 'return' || node.kind === 'emit')) {
    return `#invalid:${node.kind}`
  }
  if (layer === 'behavior' && (node.kind === 'start' || node.kind === 'ask')) {
    return `#invalid:${node.kind}`
  }
  if (layer === 'behavior' && (node.kind === 'foreach' || node.kind === 'waitShell' || node.kind === 'finish' || node.kind === 'restart')) {
    return `#invalid:${node.kind}`
  }
  return nodeScriptText(node)
}

/** 执行序节点序列（含无接线的注释）：flow = start 沿边 DFS；behavior = on 入口逐个 DFS */
function reachableSequence<N extends FlowNode | BehaviorNode>(layer: Layer, program: MergeGraph<N>): N[] {
  const byId = new Map(program.nodes.map((node) => [node.id, node]))
  const outEdges = new Map<string, GraphEdge[]>()
  for (const edge of program.edges) {
    const list = outEdges.get(edge.from)
    if (list) list.push(edge)
    else outEdges.set(edge.from, [edge])
  }
  const seen = new Set<string>()
  const seq: N[] = []
  const visit = (id: string): void => {
    if (seen.has(id)) return
    const node = byId.get(id)
    if (!node) return
    seen.add(id)
    seq.push(node)
    const edges = outEdges.get(id) ?? []
    // 稳定顺序：单出口 → true → false（与生成器的结构假设一致）
    const ordered = [...edges].sort((a, b) => portRank(a.port) - portRank(b.port))
    for (const edge of ordered) visit(edge.to)
  }
  const comments = program.nodes.filter((node) => node.kind === 'comment')
  seq.push(...comments)
  if (layer === 'flow') {
    for (const node of program.nodes) {
      if (node.kind === 'start') visit(node.id)
    }
  } else {
    for (const node of program.nodes) {
      if (node.kind === 'on') visit(node.id)
    }
  }
  return seq
}

function portRank(port: 'true' | 'false' | undefined): number {
  if (port === undefined) return 0
  return port === 'true' ? 1 : 2
}

function mergeGraph(
  layer: Layer,
  next: MergeGraph<FlowNode | BehaviorNode>,
  prev: MergeGraph<FlowNode | BehaviorNode>,
): { nodes: (FlowNode | BehaviorNode)[]; edges: GraphEdge[]; kept: number; unmatched: number; dropped: number } {
  const prevSeq = reachableSequence(layer, prev)
  const nextSeq = reachableSequence(layer, next)
  const prevUnreachable = prev.nodes.length - prevSeq.length
  const buckets = new Map<string, (FlowNode | BehaviorNode)[]>()
  for (const node of prevSeq) {
    const key = graphNodeKey(layer, node)
    const list = buckets.get(key)
    if (list) list.push(node)
    else buckets.set(key, [node])
  }
  const idMap = new Map<string, string>() // nextId → prevId
  let unmatched = 0
  for (const node of nextSeq) {
    const list = buckets.get(graphNodeKey(layer, node))
    const prevNode = list?.shift()
    if (prevNode) idMap.set(node.id, prevNode.id)
    else unmatched += 1
  }
  // 合并后 id 规划：先占住继承来的旧 id 与旧图全部 id；未配对节点保留解析 id，
  // 撞车时改 `id_2`、`id_3`…——旧图被丢弃节点的 id 不复用，避免断点/选中/高亮在
  // 「同名新节点」上假命中（docs/53 §13.5「无 id 冲突」）。
  const finalIdOf = new Map<string, string>(idMap)
  const usedIds = new Set<string>(idMap.values())
  for (const node of prev.nodes) usedIds.add(node.id)
  for (const node of next.nodes) {
    if (finalIdOf.has(node.id)) continue
    let finalId = node.id
    if (usedIds.has(finalId)) {
      let dup = 2
      while (usedIds.has(`${node.id}_${dup}`)) dup += 1
      finalId = `${node.id}_${dup}`
    }
    usedIds.add(finalId)
    finalIdOf.set(node.id, finalId)
  }
  const nextById = new Map(next.nodes.map((node) => [node.id, node]))
  const nodes = next.nodes.map((node) => {
    const finalId = finalIdOf.get(node.id) as string
    const prevId = idMap.get(node.id)
    if (prevId === undefined) return finalId === node.id ? node : { ...node, id: finalId }
    const prevNode = prevById(prev, prevId)
    const merged: Record<string, unknown> = { ...node, id: finalId }
    // 旧节点无坐标时不得写出显式 x: undefined（schema/JSON 往返会拒绝或丢失）
    if (prevNode?.x !== undefined) merged.x = prevNode.x
    else delete merged.x
    if (prevNode?.y !== undefined) merged.y = prevNode.y
    else delete merged.y
    return merged as unknown as FlowNode | BehaviorNode
  })
  const edges = next.edges.map((edge) => ({
    ...edge,
    from: finalIdOf.get(edge.from) ?? edge.from,
    to: finalIdOf.get(edge.to) ?? edge.to,
  }))
  if (nextById.size !== next.nodes.length) {
    throw new Error('脚本合并自检失败：解析产物存在重复节点 id——已阻止应用，请重新生成脚本后重试')
  }
  const finalIds = new Set<string>()
  for (const node of nodes) {
    if (finalIds.has(node.id)) {
      throw new Error(`脚本合并自检失败：节点 id「${node.id}」重复——已阻止应用，请重新生成脚本后重试`)
    }
    finalIds.add(node.id)
  }
  for (const edge of edges) {
    if (!finalIds.has(edge.from) || !finalIds.has(edge.to)) {
      throw new Error(
        `脚本合并自检失败：连线 ${edge.id} 的端点不存在（${edge.from} → ${edge.to}）——已阻止应用，请重新生成脚本后重试`,
      )
    }
    if (edge.from === edge.to) {
      throw new Error(`脚本合并自检失败：连线 ${edge.id} 形成自环（${edge.from}）——已阻止应用，请重新生成脚本后重试`)
    }
  }
  return { nodes, edges, kept: idMap.size, unmatched, dropped: prevUnreachable }
}

function prevById<N extends { id: string }>(graph: MergeGraph<N>, id: string): N | undefined {
  return graph.nodes.find((node) => node.id === id)
}

/** 回填旧 Flow 图的节点 id/坐标（保留 vars 取自解析产物） */
export function mergeFlowScriptAnchors(next: FlowProgram, prev: FlowProgram): ScriptMergeResult<FlowProgram> {
  const merged = mergeGraph('flow', next, prev)
  return {
    program: { ...next, nodes: merged.nodes as FlowNode[], edges: merged.edges },
    kept: merged.kept,
    unmatched: merged.unmatched,
    dropped: merged.dropped,
  }
}

/** 回填旧 Behavior 图的节点 id/坐标（保留 locals 取自解析产物） */
export function mergeBehaviorScriptAnchors(
  next: BehaviorProgram,
  prev: BehaviorProgram,
): ScriptMergeResult<BehaviorProgram> {
  const merged = mergeGraph('behavior', next, prev)
  return {
    program: { ...next, nodes: merged.nodes as BehaviorNode[], edges: merged.edges },
    kept: merged.kept,
    unmatched: merged.unmatched,
    dropped: merged.dropped,
  }
}
