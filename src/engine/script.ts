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
  /** handler 级已渲染节点（跨循环体汇合检测） */
  visited: Set<string>
  /** 循环体子树内已渲染节点（含循环头） */
  bodyVisited: Set<string> | null
  /** 循环体禁止到达的节点（循环后继 = 体掉出） */
  forbid: Set<string>
  /** 当前所在循环头；体遍历到达它 = 回边 */
  loopHead: string | null
  /** 体渲染期间是否发生了回边 */
  returned: boolean
}

function outOf(ctx: WalkCtx, id: string, port?: 'true' | 'false'): string | null {
  const e = ctx.edges.find((x) => x.from === id && x.port === port)
  return e ? e.to : null
}

export function generateScript(prog: GraphProgram): string {
  const base: WalkCtx = {
    byId: new Map(prog.nodes.map((n) => [n.id, n])),
    edges: prog.edges,
    visited: new Set(),
    bodyVisited: null,
    forbid: new Set(),
    loopHead: null,
    returned: false,
  }
  const chunks: string[] = []
  for (const node of prog.nodes) {
    if (node.kind !== 'on') continue
    base.visited = new Set()
    const start = outOf(base, node.id)
    const lines = start ? stmtLines(start, base) : []
    // renderIf/loop 返回多行字符串，先展开为单行数组再统一缩进
    const expanded = lines.flatMap((l) => l.split('\n')).map((l) => `  ${l}`)
    chunks.push([`on ${node.event} {`, ...expanded, `}`].join('\n'))
  }
  return chunks.join('\n\n') + (chunks.length ? '\n' : '')
}

/** 渲染从 cur 开始的语句链；分支/循环递归消费子树 */
function stmtLines(curId: string, ctx: WalkCtx): string[] {
  const lines: string[] = []
  let cur: string | null = curId
  while (cur) {
    if (ctx.loopHead && cur === ctx.loopHead) {
      ctx.returned = true
      return lines // 循环体回边：静默终止
    }
    if (ctx.bodyVisited) {
      if (ctx.forbid.has(cur)) {
        throw new Error(`伪代码无法表达从循环体跳出到节点 ${cur}（请用 branch 包裹提前结束的逻辑，或改用节点图编辑）`)
      }
      if (ctx.bodyVisited.has(cur)) throw new Error(`伪代码无法表达节点 ${cur} 被循环体内多条路径汇入（请简化图，或改用节点图编辑）`)
      ctx.bodyVisited.add(cur)
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
        lines.push(renderIf(cur, ctx))
        cur = null // branch 出边只有端口边，子树已被消费
        break
      }
      case 'loop': {
        if (node.mode === 'while' && node.cond === undefined) throw new Error(`节点 ${node.id}: while 缺少 cond`)
        if (node.mode === 'repeat' && node.times === undefined) throw new Error(`节点 ${node.id}: repeat 缺少 times`)
        const t = outOf(ctx, node.id, 'true')
        const f = outOf(ctx, node.id, 'false')
        const bodyVisited = new Set<string>([node.id])
        const forbid = new Set<string>(f ? [f] : [])
        const bodyCtx: WalkCtx = {
          ...ctx,
          bodyVisited,
          forbid,
          loopHead: node.id,
          returned: false,
        }
        const body = t ? stmtLines(t, bodyCtx) : []
        if (t && !bodyCtx.returned) {
          throw new Error(
            `伪代码无法表达循环体（节点 ${node.id}）的提前结束：体末尾必须回到循环头（如需提前结束请用 branch 包裹，或改用节点图编辑）`,
          )
        }
        const kw = node.mode === 'while' ? `while (${node.cond})` : `repeat (${node.times})`
        lines.push(`${kw} {${body.length ? `\n${indent(body)}\n` : ''}}`)
        cur = f // 循环后继走 false 边
        break
      }
    }
  }
  return lines
}

function renderIf(branchId: string, ctx: WalkCtx): string {
  const node = ctx.byId.get(branchId) as Extract<GNode, { kind: 'branch' }>
  const t = outOf(ctx, branchId, 'true')
  const f = outOf(ctx, branchId, 'false')
  const body = t ? stmtLines(t, ctx) : []
  let s = `if (${node.cond}) {${body.length ? `\n${indent(body)}\n` : ''}}`
  if (f) {
    const fNode = ctx.byId.get(f)
    if (fNode?.kind === 'branch') {
      s += ` else ${renderIf(f, ctx)}`
    } else {
      const els = stmtLines(f, ctx)
      s += ` else {${els.length ? `\n${indent(els)}\n` : ''}}`
    }
  }
  return s
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
  t: 'ident' | 'num' | 'str' | 'op' | 'term'
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
      const start = i
      while (i < src.length && src[i] !== '\n') advance(1)
      pending += src.slice(start, i)
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

/** token 流 → expr 源文本（pre 还原原始间隔，信息无损，parseExpr 重新词法） */
function tokensToString(toks: STok[]): string {
  return toks.map((t) => t.pre + (t.t === 'str' ? exprStringLiteral(t.v) : t.v)).join('')
}

// ---------------------------------------------------------------------------
// 解析器
// ---------------------------------------------------------------------------

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

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
      this.expectKw('on')
      const event = this.parseEventName()
      const onId = this.genId()
      this.newNode({ id: onId, kind: 'on', event })
      const head = this.parseBlock()
      this.link(onId, head)
      this.skipTerms()
    }
    return { nodes: this.nodes, edges: this.edges }
  }

  /** 事件名：ident (.|:) ident，如 level.started / app:tick */
  private parseEventName(): string {
    const a = this.peek()
    if (!a || a.t !== 'ident') throw new ScriptError('期望事件名', a?.line ?? 0, a?.col ?? 0)
    const dot = this.peek(1)
    const b = this.peek(2)
    if (!dot || dot.t !== 'op' || (dot.v !== '.' && dot.v !== ':') || !b || b.t !== 'ident') {
      throw new ScriptError('事件名格式应为 前缀.事件 或 名字:名字', a.line, a.col)
    }
    this.pos += 3
    return `${a.v}${dot.v}${b.v}`
  }

  /** 解析 { stmt* }，返回块内语句链的头节点（空块返回 null）；尾节点登记到 blockTails 供 loop 回边构造 */
  private parseBlock(): string | null {
    this.expectOp('{')
    const heads: string[] = []
    let tail: string | null = null
    for (;;) {
      this.skipTerms()
      const t = this.peek()
      if (!t) throw new ScriptError('块未闭合（缺少 "}"）', this.src.split('\n').length, 1)
      if (t.t === 'op' && t.v === '}') {
        this.pos++
        break
      }
      const { head, last } = this.parseStmt()
      if (tail) this.link(tail, head)
      else heads.push(head)
      tail = last
    }
    const head = heads[0] ?? null
    if (head) this.blockTails.set(head, tail!)
    return head
  }

  /** 解析一条语句；返回 { head, last }（head===last，单语句单节点） */
  private parseStmt(): { head: string; last: string } {
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
      return { head: id, last: id }
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
      return { head: id, last: id }
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
      return { head: id, last: id }
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
      return { head: id, last: id }
    }
    throw new ScriptError(`无法识别的语句 "${t.v}"（赋值应以 v. 开头，方法调用应为 实例.方法(…)）`, line, col)
  }

  private parseIf(): { head: string; last: string } {
    this.expectKw('if')
    const cond = this.readBalancedExpr()
    const branchId = this.newNode({ id: this.genId(), kind: 'branch', cond })
    const trueHead = this.parseBlock()
    this.link(branchId, trueHead, 'true')
    // else？
    const save = this.pos
    this.skipTerms()
    if (this.isKw('else')) {
      this.pos++
      this.skipTerms()
      if (this.isKw('if')) {
        const elseChain = this.parseIf()
        this.link(branchId, elseChain.head, 'false')
      } else {
        const elseHead = this.parseBlock()
        this.link(branchId, elseHead, 'false')
      }
    } else {
      this.pos = save
    }
    return { head: branchId, last: branchId }
  }

  private parseLoop(): { head: string; last: string } {
    const kw = this.peek()!.v as 'while' | 'repeat'
    this.pos++
    const exprSrc = this.readBalancedExpr()
    const loopId = this.genId()
    const node: GNode =
      kw === 'while' ? { id: loopId, kind: 'loop', mode: 'while', cond: exprSrc } : { id: loopId, kind: 'loop', mode: 'repeat', times: exprSrc }
    this.newNode(node)
    const bodyHead = this.parseBlock()
    // 文本 while/repeat 语义：体完自动回条件——显式构造回边
    this.link(loopId, bodyHead, 'true')
    if (bodyHead) {
      const tail = this.blockTails.get(bodyHead)
      if (tail) this.edges.push({ id: `e${this.edges.length + 1}`, from: tail, to: loopId })
    }
    return { head: loopId, last: loopId }
  }

  /** 各块头节点对应的尾节点（构造 loop 回边用） */
  private blockTails = new Map<string, string>()

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
      if (depth === 0 && t.t === 'op' && t.v === ')') {
        if (toks.length) parts.push(tokensToString(toks).trim())
        return parts
      }
      if (t.t === 'op' && (t.v === '(' || t.v === '[' || t.v === '{')) depth++
      if (t.t === 'op' && (t.v === ')' || t.v === ']' || t.v === '}')) depth--
      if (depth === 0 && t.t === 'op' && t.v === ',') {
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
    for (;;) {
      const t = this.peek()
      if (!t || t.t === 'term' || (t.t === 'op' && t.v === '}')) break
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

  /** 语句结束：消费分隔符（; 或换行）；块尾 } 前允许无分隔符 */
  private endStmt(): void {
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
