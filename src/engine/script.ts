/**
 * LevelScript：GraphProgram 的伪代码投影（C/JS 风格，docs/12 §6）。
 *
 * - generateScript：IR → 文本。语句与节点一一对应；注释节点输出为 // 行；
 *   结构性限制：节点被多条路径汇入、loop 体末尾不回到循环头（提前结束）时抛 ScriptError
 *   （图语言自由，伪代码只覆盖结构化子集——两类结构请用节点图编辑）。
 * - parseScript：文本 → IR。变量不在脚本中（由编辑器变量面板管理），从 opts.variables 保留。
 * - 往返恒等：generateScript(parseScript(generateScript(p))) === generateScript(p)。
 *
 * 表达式直接复用 expr 引擎：语句层自产 token（带行列号），提取出的表达式 token 流
 * 还原为源文本交给 parseExpr——零侵入且错误定位到行。
 */

import { parseExpr, type Json } from './expr'
import { exprStringLiteral } from './migrate'
import type { GEdge, GNode, GraphProgram, RValue } from './graphProgram'

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

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

interface WalkCtx {
  byId: Map<string, GNode>
  edges: GEdge[]
  /** handler 级已渲染节点 */
  visited: Set<string>
  /** 汇合点缓存：branch id → 结构化汇合点（null = 无后继） */
  joins: Map<string, string | null>
}

function outOf(ctx: WalkCtx, id: string, port?: 'true' | 'false'): string | null {
  const e = ctx.edges.find((x) => x.from === id && x.port === port)
  return e ? e.to : null
}

/** 从 start 沿执行边 BFS 距离图 */
function bfsFrom(ctx: WalkCtx, start: string): Map<string, number> {
  const dist = new Map<string, number>([[start, 0]])
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    const node = ctx.byId.get(cur)
    if (!node) continue
    const nexts =
      node.kind === 'branch' || node.kind === 'loop'
        ? [outOf(ctx, cur, 'true'), outOf(ctx, cur, 'false')].filter((x): x is string => !!x)
        : [outOf(ctx, cur)].filter((x): x is string => !!x)
    for (const next of nexts) {
      if (!dist.has(next)) {
        dist.set(next, dist.get(cur)! + 1)
        queue.push(next)
      }
    }
  }
  return dist
}

/**
 * branch 的结构化汇合点：true/false 两分支都可达的节点中（BFS 距离和最小）者。
 * `if (c) {A} else {B}; C` 的图上 A 尾与 B 尾都连 C —— C 即汇合点，渲染 if 后顺序继续。
 * 无公共后继（任一分支掉出 = 处理器结束）返回 null。
 */
function joinOf(ctx: WalkCtx, branchId: string): string | null {
  if (ctx.joins.has(branchId)) return ctx.joins.get(branchId)!
  const t = outOf(ctx, branchId, 'true')
  const f = outOf(ctx, branchId, 'false')
  let best: string | null = null
  if (t && f) {
    const distT = bfsFrom(ctx, t)
    const distF = bfsFrom(ctx, f)
    let bestSum = Infinity
    for (const [n, d1] of distT) {
      const d2 = distF.get(n)
      if (d2 !== undefined && d1 + d2 < bestSum) {
        best = n
        bestSum = d1 + d2
      }
    }
  }
  ctx.joins.set(branchId, best)
  return best
}

interface ChainOpts {
  /** 汇合点：到达即停（不渲染，由外层顺序链消费） */
  stopAt?: string | null
  /** 循环体子树内已渲染节点（含循环头） */
  bodyVisited?: Set<string> | null
  /** 循环体禁止到达的节点（循环后继 = 体掉出） */
  forbid?: Set<string>
  /** 当前所在循环头；体遍历到达它 = 回边 */
  loopHead?: string | null
}

/** 渲染从 curId 开始的语句链，直到掉出 / 到达 stopAt（汇合点，不渲染）/ 回边 */
function chain(curId: string, ctx: WalkCtx, opts: ChainOpts = {}): { lines: string[]; returned: boolean } {
  const lines: string[] = []
  let returned = false
  let cur: string | null = curId
  const loopHead = opts.loopHead ?? null
  const bodyVisited = opts.bodyVisited ?? null
  const forbid = opts.forbid ?? null
  while (cur && cur !== opts.stopAt) {
    if (loopHead && cur === loopHead) {
      returned = true
      break
    }
    if (bodyVisited) {
      if (forbid?.has(cur)) {
        throw new Error(`伪代码无法表达从循环体跳出到节点 ${cur}（请用 branch 包裹提前结束的逻辑，或改用节点图编辑）`)
      }
      if (bodyVisited.has(cur)) throw new Error(`伪代码无法表达节点 ${cur} 被循环体内多条路径汇入（请简化图，或改用节点图编辑）`)
      bodyVisited.add(cur)
    }
    if (ctx.visited.has(cur)) throw new Error(`伪代码无法表达节点 ${cur} 被多条路径汇入（请简化图结构，或改用节点图编辑）`)
    ctx.visited.add(cur)
    const node = ctx.byId.get(cur)!
    switch (node.kind) {
      case 'on':
        throw new Error(`节点 ${node.id}：on 不能被顺序执行到`)
      case 'comment':
        lines.push(`// ${node.text.replace(/\n/g, ' ')}`)
        cur = outOf(ctx, cur)
        break
      case 'call':
        lines.push(`${node.target}.${node.method}(${node.args.join(', ')})`)
        cur = outOf(ctx, cur)
        break
      case 'assign':
        lines.push(`v.${node.target} = ${rvalueText(node.value)}`)
        cur = outOf(ctx, cur)
        break
      case 'emit': {
        const entries = Object.entries(node.payload ?? {})
        const payload = entries.length ? ` {${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}}` : ''
        lines.push(`emit ${exprStringLiteral(node.event)}${payload}`)
        cur = outOf(ctx, cur)
        break
      }
      case 'wait':
        lines.push(`wait (${node.ms})`)
        cur = outOf(ctx, cur)
        break
      case 'branch': {
        const j = joinOf(ctx, cur)
        lines.push(renderIf(cur, j, ctx, opts))
        cur = j
        break
      }
      case 'loop': {
        if (node.mode === 'while' && node.cond === undefined) throw new Error(`节点 ${node.id}: while 缺少 cond`)
        if (node.mode === 'repeat' && node.times === undefined) throw new Error(`节点 ${node.id}: repeat 缺少 times`)
        const t = outOf(ctx, node.id, 'true')
        const f = outOf(ctx, node.id, 'false')
        const body = t
          ? chain(t, ctx, {
              bodyVisited: new Set<string>([node.id]),
              forbid: new Set<string>(f ? [f] : []),
              loopHead: node.id,
            })
          : { lines: [] as string[], returned: false }
        if (t && !body.returned) {
          throw new Error(
            `伪代码无法表达循环体（节点 ${node.id}）的提前结束：体末尾必须回到循环头（如需提前结束请用 branch 包裹，或改用节点图编辑）`,
          )
        }
        const kw = node.mode === 'while' ? `while (${node.cond})` : `repeat (${node.times})`
        lines.push(`${kw} {${body.lines.length ? `
${indent(body.lines)}
` : ''}}`)
        cur = f
        break
      }
    }
  }
  return { lines, returned }
}

/** 渲染 if / else-if 链；两分支体渲染到汇合点 j 为止（继承当前循环上下文 opts） */
function renderIf(branchId: string, j: string | null, ctx: WalkCtx, opts: ChainOpts = {}): string {
  const node = ctx.byId.get(branchId) as Extract<GNode, { kind: 'branch' }>
  const t = outOf(ctx, branchId, 'true')
  const f = outOf(ctx, branchId, 'false')
  const body = t ? chain(t, ctx, { ...opts, stopAt: j }).lines : []
  let s = `if (${node.cond}) {${body.length ? `
${indent(body)}
` : ''}}`
  // false 出口直达汇合点 = 语义上无 else 分支体，省略 else
  if (f && f !== j) {
    const fNode = ctx.byId.get(f)
    if (fNode?.kind === 'branch') {
      s += ` else ${renderIf(f, j, ctx, opts)}`
    } else {
      const els = chain(f, ctx, { ...opts, stopAt: j }).lines
      s += ` else {${els.length ? `
${indent(els)}
` : ''}}`
    }
  }
  return s
}

export function generateScript(prog: GraphProgram): string {
  const base: WalkCtx = {
    byId: new Map(prog.nodes.map((n) => [n.id, n])),
    edges: prog.edges,
    visited: new Set(),
    joins: new Map(),
  }
  const chunks: string[] = []
  for (const node of prog.nodes) {
    if (node.kind !== 'on') continue
    base.visited = new Set()
    base.joins = new Map()
    const start = outOf(base, node.id)
    const lines = start ? chain(start, base).lines : []
    // renderIf/loop 返回多行字符串，先展开为单行数组再统一缩进
    const expanded = lines.flatMap((l) => l.split('\n')).map((l) => `  ${l}`)
    chunks.push([`on ${node.event} {`, ...expanded, `}`].join('\n'))
  }
  return chunks.join('\n\n') + (chunks.length ? '\n' : '')
}

function rvalueText(rv: RValue): string {
  if ('expr' in rv) return rv.expr
  return `${rv.call.target}.${rv.call.method}(${rv.call.args.join(', ')})`
}

function indent(lines: string[]): string {
  return lines.map((l) => `  ${l}`).join('\n')
}

// ---------------------------------------------------------------------------
// 语句层词法（带行列号；表达式 token 流还原为文本后交给 parseExpr）
// ---------------------------------------------------------------------------

interface STok {
  t: 'ident' | 'num' | 'str' | 'op' | 'term' | 'comment'
  v: string
  /** 与前一 token 之间的原始空白（含注释文本），tokensToString 还原源文本用 */
  pre: string
  line: number
  col: number
}

function lexScript(src: string): STok[] {
  const toks: STok[] = []
  let line = 1
  let col = 1
  let i = 0
  let pending = ''
  const push = (t: STok['t'], v: string): void => {
    toks.push({ t, v, pre: pending, line, col })
    pending = ''
    col += v.length
  }
  const advance = (n: number): void => {
    i += n
    col += n
  }
  while (i < src.length) {
    const c = src[i]
    if (c === '\n') {
      toks.push({ t: 'term', v: '\n', pre: pending, line, col })
      pending = ''
      line++
      col = 1
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      pending += c
      advance(1)
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      // 注释成为独立 token：语句位置被提升为 comment 节点，表达式内/行尾被丢弃
      let j = i + 2
      while (j < src.length && src[j] !== '\n') j++
      push('comment', src.slice(i + 2, j).trim())
      advance(j - i)
      continue
    }
    if (c === ';') {
      push('term', ';')
      i++
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9]/.test(src[j])) j++
      if (src[j] === '.') {
        j++
        while (j < src.length && /[0-9]/.test(src[j])) j++
      }
      push('num', src.slice(i, j))
      advance(j - i)
      continue
    }
    if (c === "'" || c === '"') {
      let j = i + 1
      let out = ''
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const next = src[j + 1]
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next
          j += 2
        } else {
          out += src[j]
          j++
        }
      }
      if (j >= src.length) throw new ScriptError('字符串未闭合', line, col)
      push('str', out)
      advance(j + 1 - i)
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      push('ident', src.slice(i, j))
      advance(j - i)
      continue
    }
    const two = src.slice(i, i + 2)
    if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) {
      push('op', two)
      advance(2)
      continue
    }
    if ('{}(),:.[]+-*/%<>!?='.includes(c)) {
      push('op', c)
      i++
      col++
      continue
    }
    throw new ScriptError(`无法识别的字符 ${JSON.stringify(c)}`, line, col)
  }
  return toks
}

/** token 流 → expr 源文本（pre 还原原始间隔，信息无损，parseExpr 重新词法；comment 不应出现在表达式内） */
function tokensToString(toks: STok[]): string {
  return toks
    .filter((t) => t.t !== 'comment')
    .map((t) => t.pre + (t.t === 'str' ? exprStringLiteral(t.v) : t.v))
    .join('')
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 语句/块的出口：需要连接「块内下一条语句（顺序后继）」的边 */
interface Exit {
  node: string
  port?: 'true' | 'false'
}
interface StmtPiece {
  head: string | null
  exits: Exit[]
}

class ScriptParser {
  private toks: STok[]
  private pos = 0
  private nodes: GNode[] = []
  private edges: GEdge[] = []
  private seq = 0
  private lastLine = 0
  private lastCol = 0

  constructor(
    private src: string,
    private idPrefix: string,
  ) {
    this.toks = lexScript(src)
  }

  private peek(k = 0): STok | undefined {
    const t = this.toks[this.pos + k]
    if (t) {
      this.lastLine = t.line
      this.lastCol = t.col
    }
    return t
  }

  private isKw(k: string, at = 0): boolean {
    const t = this.peek(at)
    return t?.t === 'ident' && t.v === k
  }

  private skipTerms(): void {
    while (this.peek()?.t === 'term') this.pos++
  }

  private expectKw(k: string): void {
    const t = this.peek()
    if (!t || t.t !== 'ident' || t.v !== k) {
      throw new ScriptError(`期望 "${k}"${t ? `，得到 "${t.v}"` : '，但已到文件末尾'}`, t?.line ?? 0, t?.col ?? 0)
    }
    this.pos++
  }

  private expectOp(op: string): void {
    const t = this.peek()
    if (!t || t.t !== 'op' || t.v !== op) {
      throw new ScriptError(`期望 "${op}"${t ? `，得到 "${t.v}"` : ''}`, t?.line ?? 0, t?.col ?? 0)
    }
    this.pos++
  }

  private newNode(node: GNode): string {
    this.nodes.push(node)
    return node.id
  }

  private genId(): string {
    this.seq++
    return `${this.idPrefix}${this.seq}`
  }

  private link(from: string, to: string | null, port?: 'true' | 'false'): void {
    if (!to) return
    this.edges.push({ id: `e${this.edges.length + 1}`, from, to, ...(port ? { port } : {}) })
  }

  parse(): { nodes: GNode[]; edges: GEdge[] } {
    this.skipTerms()
    while (this.peek()) {
      const t = this.peek()!
      if (t.t === 'comment') {
        // 顶层独立注释保留为 comment 节点（不参与连线，往返不丢失）
        this.pos++
        this.newNode({ id: this.genId(), kind: 'comment', text: t.v.trim() })
        this.skipTerms()
        continue
      }
      this.expectKw('on')
      const event = this.parseEventName()
      const onId = this.genId()
      this.newNode({ id: onId, kind: 'on', event })
      const piece = this.parseBlock()
      this.link(onId, piece.head)
      // piece.exits 挂空 = 处理器结束
      this.skipTerms()
    }
    return { nodes: this.nodes, edges: this.edges }
  }

  /** 事件名：ident (.|:) ident 的重复段，如 level.started / app:tick（与 EVENT_RE 多段一致） */
  private parseEventName(): string {
    let out = ''
    const a = this.peek()
    if (!a || a.t !== 'ident') throw new ScriptError('期望事件名', a?.line ?? 0, a?.col ?? 0)
    out += a.v
    this.pos++
    for (;;) {
      const dot = this.peek()
      const b = this.peek(1)
      if (dot?.t === 'op' && (dot.v === '.' || dot.v === ':') && b?.t === 'ident') {
        out += dot.v + b.v
        this.pos += 2
        continue
      }
      break
    }
    if (!out.includes('.') && !out.includes(':')) {
      throw new ScriptError('事件名格式应为 前缀.事件 或 名字:名字', a.line, a.col)
    }
    return out
  }

  /**
   * 解析 { stmt* }。块内顺序链接：每条语句的 exits 按端口连到下一条语句的头；
   * branch/loop 的块级出口自动带 'false' 端口（与 connect/lint 的端口协议一致）。
   */
  private parseBlock(): StmtPiece {
    this.expectOp('{')
    let head: string | null = null
    let pending: Exit[] = []
    for (;;) {
      this.skipTerms()
      const t = this.peek()
      if (!t) throw new ScriptError('块未闭合（缺少 "}"）', this.src.split('\n').length, 1)
      if (t.t === 'op' && t.v === '}') {
        this.pos++
        break
      }
      const piece: StmtPiece = t.t === 'comment' ? this.commentPiece() : this.parseStmt()
      if (head === null) head = piece.head
      else for (const e of pending) this.link(e.node, piece.head, e.port)
      pending = piece.exits
    }
    return { head, exits: pending }
  }

  /** 独立成行的注释 → comment 语句节点（执行直通，往返保留） */
  private commentPiece(): StmtPiece {
    const t = this.peek()!
    this.pos++
    const id = this.newNode({ id: this.genId(), kind: 'comment', text: t.v.trim() })
    return { head: id, exits: [{ node: id }] }
  }

  private parseStmt(): StmtPiece {
    const t = this.peek()!
    const line = t.line
    const col = t.col
    if (t.t !== 'ident') throw new ScriptError(`无法识别的语句开头 "${t.v}"`, line, col)

    if (t.v === 'if') return this.parseIf()
    if (t.v === 'while' || t.v === 'repeat') return this.parseLoop()
    if (t.v === 'wait') {
      this.pos++
      const ms = this.readBalancedExpr()
      this.endStmt()
      const id = this.newNode({ id: this.genId(), kind: 'wait', ms })
      return { head: id, exits: [{ node: id }] }
    }
    if (t.v === 'emit') {
      this.pos++
      const ev = this.peek()
      if (!ev || ev.t !== 'str') throw new ScriptError("emit 需要 '名字:名字' 字符串", line, col)
      this.pos++
      let payload: Record<string, string> | undefined
      const brace = this.peek()
      if (brace && brace.t === 'op' && brace.v === '{') {
        const objSrc = this.readBalancedRaw()
        payload = this.parsePayloadObject(objSrc, brace.line, brace.col)
      }
      this.endStmt()
      const id = this.newNode({ id: this.genId(), kind: 'emit', event: ev.v, ...(payload ? { payload } : {}) })
      return { head: id, exits: [{ node: id }] }
    }
    // 赋值：v . ident = rvalue
    if (t.v === 'v' && this.peek(1)?.t === 'op' && this.peek(1)!.v === '.') {
      this.pos += 2
      const name = this.peek()
      if (!name || name.t !== 'ident' || !ID_RE.test(name.v)) throw new ScriptError('期望变量名', line, col)
      this.pos++
      this.expectOp('=')
      const value = this.parseRValue()
      this.endStmt()
      const id = this.newNode({ id: this.genId(), kind: 'assign', target: name.v, value })
      return { head: id, exits: [{ node: id }] }
    }
    // 调用语句：ident . ident ( args? )
    if (
      this.peek(1)?.t === 'op' &&
      this.peek(1)!.v === '.' &&
      this.peek(2)?.t === 'ident' &&
      this.peek(3)?.t === 'op' &&
      this.peek(3)!.v === '('
    ) {
      const target = t.v
      const method = this.peek(2)!.v
      this.pos += 4
      const args = this.peek()?.t === 'op' && this.peek()!.v === ')' ? [] : this.readArgList()
      this.expectOp(')')
      this.endStmt()
      const id = this.newNode({ id: this.genId(), kind: 'call', target, method, args })
      return { head: id, exits: [{ node: id }] }
    }
    throw new ScriptError(`无法识别的语句 "${t.v}"（赋值应以 v. 开头，方法调用应为 实例.方法(…)）`, line, col)
  }

  /**
   * if 语句。出口协议：
   * - 有 else：两分支体各自的 exits（无端口汇合边）都成为块级出口；空 else 块时
   *   branch 的 false 出口没有目标节点，以 { branch, 'false' } 上传（连到块级后继）
   * - 无 else：分支体 exits + branch 自身的 'false' 出口
   */
  private parseIf(): StmtPiece {
    this.expectKw('if')
    const cond = this.readBalancedExpr()
    const branchId = this.newNode({ id: this.genId(), kind: 'branch', cond })
    const thenPiece = this.parseBlock()
    this.link(branchId, thenPiece.head, 'true')
    const save = this.pos
    this.skipTerms()
    if (this.isKw('else')) {
      this.pos++
      this.skipTerms()
      const elsePiece: StmtPiece = this.isKw('if') ? this.parseIf() : this.parseBlock()
      this.link(branchId, elsePiece.head, 'false')
      const elseExits: Exit[] = elsePiece.head ? elsePiece.exits : [{ node: branchId, port: 'false' }]
      return { head: branchId, exits: [...thenPiece.exits, ...elseExits] }
    }
    this.pos = save
    return { head: branchId, exits: [...thenPiece.exits, { node: branchId, port: 'false' }] }
  }

  /** while/repeat 语句：体块出口全部连回循环头（无端口回边），循环自身以 'false' 出口进入后继 */
  private parseLoop(): StmtPiece {
    const kw = this.peek()!.v as 'while' | 'repeat'
    this.pos++
    const exprSrc = this.readBalancedExpr()
    const loopId = this.genId()
    const node: GNode =
      kw === 'while'
        ? { id: loopId, kind: 'loop', mode: 'while', cond: exprSrc }
        : { id: loopId, kind: 'loop', mode: 'repeat', times: exprSrc }
    this.newNode(node)
    const bodyPiece = this.parseBlock()
    this.link(loopId, bodyPiece.head, 'true')
    // 文本 while/repeat 语义：体完自动回条件——体块所有出口连回循环头。
    // 保留出口端口：体尾若是 branch/loop，其出口带端口（该边同时是它们的端口出边）
    for (const e of bodyPiece.exits) this.link(e.node, loopId, e.port)
    return { head: loopId, exits: [{ node: loopId, port: 'false' }] }
  }

  // —— 表达式/参数提取 ——

  /** 从起始 "(" 收集到配对 ")"，返回**剥掉首尾括号**的 expr 源文本（空白按原文还原） */
  private readBalancedExpr(): string {
    const toks = this.readBalancedRaw()
    const inner = toks.slice(1, -1)
    return tokensToString(inner).trim()
  }

  private readBalancedRaw(): STok[] {
    const out: STok[] = []
    let depth = 0
    for (;;) {
      const t = this.peek()
      if (!t) throw new ScriptError('括号未闭合（已到文件末尾）', this.lastLine, this.lastCol)
      if (t.t === 'comment') {
        this.pos++
        continue
      }
      if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++
      else if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) {
        out.push(t)
        this.pos++
        depth--
        if (depth === 0) return out // 与起始括号配对完成（含闭合括号）
        continue
      }
      out.push(t)
      this.pos++
    }
  }

  /** 括号内参数列表，按顶层逗号拆分为 expr 文本数组（每项 trim，间隔由生成器统一） */
  private readArgList(): string[] {
    const toks: STok[] = []
    let depth = 0
    const parts: string[] = []
    for (;;) {
      const t = this.peek()
      if (!t) throw new ScriptError('参数列表未闭合（已到文件末尾）', this.lastLine, this.lastCol)
      if (t.t === 'comment') {
        this.pos++
        continue
      }
      if (depth === 0 && t.t === 'op' && t.v === ')') {
        if (toks.length) parts.push(tokensToString(toks).trim())
        return parts
      }
      if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++
      if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) depth--
      if (depth === 0 && t.t === 'op' && t.v === ',') {
        if (!toks.length) throw new ScriptError('函数调用存在空参数', t.line, t.col)
        parts.push(tokensToString(toks).trim())
        toks.length = 0
        this.pos++
        continue
      }
      toks.push(t)
      this.pos++
    }
  }

  /** 对象字面量 token 文本 → 每 key 的 expr 文本（emit payload 用） */
  private parsePayloadObject(src: STok[], line: number, col: number): Record<string, string> {
    const text = tokensToString(src)
    let ast: ReturnType<typeof parseExpr>
    try {
      ast = parseExpr(text)
    } catch (e) {
      throw new ScriptError(`payload 对象表达式错误: ${(e as Error).message}`, line, col)
    }
    if (ast.k !== 'obj') throw new ScriptError('emit 的 payload 必须是对象字面量', line, col)
    // 从 token 流按顶层逗号拆 key: tokens，保持用户源文本
    const out: Record<string, string> = {}
    const inner = src.slice(1, -1) // 去掉 { }
    let buf: STok[] = []
    let depth = 0
    const flush = (): void => {
      if (!buf.length) return
      const key = buf[0]
      const colon = buf[1]
      if (key.t !== 'ident' || !colon || colon.t !== 'op' || colon.v !== ':') {
        throw new ScriptError('payload 项应为 key: 表达式', line, col)
      }
      out[key.v] = tokensToString(buf.slice(2)).trim()
      buf = []
    }
    for (const t of inner) {
      if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++
      if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) depth--
      if (depth === 0 && t.t === 'op' && t.v === ',') {
        flush()
        continue
      }
      buf.push(t)
    }
    flush()
    return out
  }

  /** 赋值右侧：ident.ident(…) 调用 或 表达式 */
  private parseRValue(): RValue {
    const a = this.peek()
    const b = this.peek(1)
    const c = this.peek(2)
    const d = this.peek(3)
    if (a && a.t === 'ident' && b?.t === 'op' && b.v === '.' && c?.t === 'ident' && d?.t === 'op' && d.v === '(') {
      // 调用（d 是 "("）：readBalancedRaw 从 "(" 起收集到配对 ")" 前并停在 ")"，再手工消费 ")"/参数拆分
      this.pos += 4
      const args = this.peek()?.t === 'op' && this.peek()!.v === ')' ? [] : this.readArgList()
      this.expectOp(')')
      return { call: { target: a.v, method: c.v, args } }
    }
    const toks: STok[] = []
    let depth = 0
    for (;;) {
      const t = this.peek()
      if (!t || t.t === 'term' || t.t === 'comment') break
      if (t.t === 'op') {
        if (t.v === '{' || t.v === '(' || t.v === '[') depth++
        else if (t.v === '}' || t.v === ')' || t.v === ']') {
          if (depth === 0) break // 块闭合 = 语句边界（对象字面量内部的 } 已被深度保护）
          depth--
        }
      }
      toks.push(t)
      this.pos++
    }
    if (!toks.length) throw new ScriptError('赋值缺少右侧表达式', a?.line ?? 0, a?.col ?? 0)
    const expr = tokensToString(toks).trim()
    try {
      parseExpr(expr) // 语法前置校验，错误带行号
    } catch (e) {
      throw new ScriptError(`表达式错误: ${(e as Error).message}`, a?.line ?? 0, a?.col ?? 0)
    }
    return { expr }
  }

  /** 语句结束：消费分隔符（; 或换行）；行尾注释随语句结束被丢弃；块尾 } 前允许无分隔符 */
  private endStmt(): void {
    while (this.peek()?.t === 'comment') this.pos++
    const t = this.peek()
    if (t && t.t === 'term') {
      this.pos++
      return
    }
    if (t && t.t === 'op' && t.v === '}') return
    if (t) throw new ScriptError(`语句后应换行或 ";"，得到 "${t.v}"`, t.line, t.col)
  }
}

export function parseScript(
  text: string,
  opts?: { variables?: Record<string, Json>; idPrefix?: string },
): GraphProgram {
  const parser = new ScriptParser(text, opts?.idPrefix ?? 's')
  const { nodes, edges } = parser.parse()
  return {
    logicVersion: 2,
    variables: structuredClone(opts?.variables ?? {}),
    nodes,
    edges,
  }
}
