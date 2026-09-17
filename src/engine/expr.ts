/**
 * 安全表达式求值器 —— 逻辑系统的"简易代码"层。
 *
 * 安全边界（UGC 关卡作者只能写这种表达式）：
 * - 无赋值、无循环、无 new、无成员方法调用
 * - 成员访问只能从作用域根出发：event（事件负载）/ q（题目对象）/ v（变量）
 * - 只允许白名单函数，函数无副作用
 * - 解析深度与求值步数有预算，超限抛错
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface ExprScope {
  event: Json
  q: Json | null
  v: Record<string, Json>
}

export interface ExprContext {
  /** AudioContext 时钟秒（节奏相关函数用）；缺省用 performance.now */
  getNowSeconds?: () => number
  /** 单次求值步数预算 */
  stepBudget?: number
}

export class ExprError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExprError'
  }
}

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

type TokType = 'num' | 'str' | 'ident' | 'op'
interface Tok {
  t: TokType
  v: string | number
}

const OPS3: string[] = []
const OPS2 = ['==', '!=', '<=', '>=', '&&', '||']
const OPS1 = ['+', '-', '*', '/', '%', '<', '>', '!', '?', ':', '(', ')', ',', '.', '[', ']']

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && /[0-9]/.test(src[j])) j++
      if (src[j] === '.') {
        j++
        while (j < src.length && /[0-9]/.test(src[j])) j++
      }
      toks.push({ t: 'num', v: Number(src.slice(i, j)) })
      i = j
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
      if (j >= src.length) throw new ExprError('字符串未闭合')
      toks.push({ t: 'str', v: out })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      toks.push({ t: 'ident', v: src.slice(i, j) })
      i = j
      continue
    }
    const three = src.slice(i, i + 3)
    if (OPS3.includes(three)) {
      toks.push({ t: 'op', v: three })
      i += 3
      continue
    }
    const two = src.slice(i, i + 2)
    if (OPS2.includes(two)) {
      toks.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if (OPS1.includes(c)) {
      toks.push({ t: 'op', v: c })
      i++
      continue
    }
    throw new ExprError(`无法识别的字符: ${JSON.stringify(c)}`)
  }
  return toks
}

// ---------------------------------------------------------------------------
// 语法（Pratt 式递归下降，深度受限）
// ---------------------------------------------------------------------------

export type Ast =
  | { k: 'lit'; v: Json }
  | { k: 'path'; parts: string[] }
  | { k: 'array'; items: Ast[] }
  | { k: 'index'; obj: Ast; idx: Ast }
  | { k: 'call'; name: string; args: Ast[] }
  | { k: 'un'; op: '!' | '-'; a: Ast }
  | { k: 'bin'; op: string; a: Ast; b: Ast }
  | { k: 'tern'; c: Ast; a: Ast; b: Ast }

const MAX_DEPTH = 48

class Parser {
  private toks: Tok[]
  private pos = 0
  private depth = 0

  constructor(src: string) {
    this.toks = tokenize(src)
  }

  parse(): Ast {
    const node = this.ternary()
    if (this.pos !== this.toks.length) throw new ExprError(`表达式末尾有多余内容: ${String(this.toks[this.pos]?.v)}`)
    return node
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos]
  }

  private eatOp(op: string): boolean {
    const t = this.peek()
    if (t && t.t === 'op' && t.v === op) {
      this.pos++
      return true
    }
    return false
  }

  private expectOp(op: string): void {
    if (!this.eatOp(op)) throw new ExprError(`期望 "${op}"`)
  }

  private enter(): void {
    if (++this.depth > MAX_DEPTH) throw new ExprError('表达式嵌套过深')
  }

  private exit(): void {
    this.depth--
  }

  private ternary(): Ast {
    this.enter()
    try {
      const cond = this.logicalOr()
      if (this.eatOp('?')) {
        const a = this.ternary()
        this.expectOp(':')
        const b = this.ternary()
        return { k: 'tern', c: cond, a, b }
      }
      return cond
    } finally {
      this.exit()
    }
  }

  private binLevel(ops: string[], next: () => Ast): Ast {
    this.enter()
    try {
      let left = next()
      for (;;) {
        const t = this.peek()
        if (t && t.t === 'op' && ops.includes(String(t.v))) {
          this.pos++
          const right = next()
          left = { k: 'bin', op: String(t.v), a: left, b: right }
        } else {
          return left
        }
      }
    } finally {
      this.exit()
    }
  }

  private logicalOr(): Ast {
    return this.binLevel(['||'], () => this.logicalAnd())
  }
  private logicalAnd(): Ast {
    return this.binLevel(['&&'], () => this.equality())
  }
  private equality(): Ast {
    return this.binLevel(['==', '!='], () => this.relational())
  }
  private relational(): Ast {
    return this.binLevel(['<', '<=', '>', '>='], () => this.additive())
  }
  private additive(): Ast {
    return this.binLevel(['+', '-'], () => this.multiplicative())
  }
  private multiplicative(): Ast {
    return this.binLevel(['*', '/', '%'], () => this.unary())
  }

  private unary(): Ast {
    if (this.eatOp('!')) return { k: 'un', op: '!', a: this.unary() }
    if (this.eatOp('-')) return { k: 'un', op: '-', a: this.unary() }
    return this.primary()
  }

  private primary(): Ast {
    const t = this.peek()
    if (!t) throw new ExprError('表达式意外结束')
    if (t.t === 'num') {
      this.pos++
      return this.postfix({ k: 'lit', v: t.v as number })
    }
    if (t.t === 'str') {
      this.pos++
      return this.postfix({ k: 'lit', v: t.v as string })
    }
    if (t.t === 'op' && t.v === '(') {
      this.pos++
      const inner = this.ternary()
      this.expectOp(')')
      return this.postfix(inner)
    }
    if (t.t === 'op' && t.v === '[') {
      this.pos++
      const items: Ast[] = []
      if (!this.eatOp(']')) {
        do {
          items.push(this.ternary())
        } while (this.eatOp(','))
        this.expectOp(']')
      }
      return this.postfix({ k: 'array', items })
    }
    if (t.t === 'ident') {
      this.pos++
      const name = String(t.v)
      if (this.eatOp('(')) {
        const args: Ast[] = []
        if (!this.eatOp(')')) {
          do {
            args.push(this.ternary())
          } while (this.eatOp(','))
          this.expectOp(')')
        }
        return this.postfix({ k: 'call', name, args })
      }
      const parts = [name]
      while (this.eatOp('.')) {
        const id = this.peek()
        if (!id || id.t !== 'ident') throw new ExprError(`"." 后应为属性名`)
        this.pos++
        parts.push(String(id.v))
      }
      if (name === 'true') return this.postfix({ k: 'lit', v: true })
      if (name === 'false') return this.postfix({ k: 'lit', v: false })
      if (name === 'null') return this.postfix({ k: 'lit', v: null })
      return this.postfix({ k: 'path', parts })
    }
    throw new ExprError(`意外的符号: ${String(t.v)}`)
  }

  /** 后缀下标访问：a[i]、q.data.seq[0]、(a concat b)[1] */
  private postfix(base: Ast): Ast {
    let node = base
    while (this.eatOp('[')) {
      const idx = this.ternary()
      this.expectOp(']')
      node = { k: 'index', obj: node, idx }
    }
    return node
  }
}

export function parseExpr(src: string): Ast {
  if (src.length > 2000) throw new ExprError('表达式过长')
  return new Parser(src).parse()
}

// ---------------------------------------------------------------------------
// 函数白名单
// ---------------------------------------------------------------------------

interface FuncDef {
  minArgs: number
  maxArgs: number
  fn: (args: Json[], ctx: ExprContext) => Json
}

function num(x: Json, fn: string): number {
  if (typeof x !== 'number') throw new ExprError(`${fn} 需要数字参数`)
  return x
}

import { Note } from 'tonal'

const FUNCS: Record<string, FuncDef> = {
  abs: { minArgs: 1, maxArgs: 1, fn: ([a]) => Math.abs(num(a, 'abs')) },
  min: { minArgs: 1, maxArgs: 8, fn: (a) => Math.min(...a.map((x) => num(x, 'min'))) },
  max: { minArgs: 1, maxArgs: 8, fn: (a) => Math.max(...a.map((x) => num(x, 'max'))) },
  round: { minArgs: 1, maxArgs: 1, fn: ([a]) => Math.round(num(a, 'round')) },
  floor: { minArgs: 1, maxArgs: 1, fn: ([a]) => Math.floor(num(a, 'floor')) },
  ceil: { minArgs: 1, maxArgs: 1, fn: ([a]) => Math.ceil(num(a, 'ceil')) },
  random: { minArgs: 0, maxArgs: 0, fn: () => Math.random() },
  randomInt: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([a, b]) => {
      const lo = Math.ceil(num(a, 'randomInt'))
      const hi = Math.floor(num(b, 'randomInt'))
      if (hi < lo) throw new ExprError('randomInt 上界小于下界')
      return lo + Math.floor(Math.random() * (hi - lo + 1))
    },
  },
  len: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => {
      if (Array.isArray(a) || typeof a === 'string') return a.length
      if (a !== null && typeof a === 'object') return Object.keys(a).length
      throw new ExprError('len 只接受数组、字符串或对象')
    },
  },
  now: {
    minArgs: 0,
    maxArgs: 0,
    fn: (_a, ctx) => (ctx.getNowSeconds ? ctx.getNowSeconds() : performance.now() / 1000),
  },
  midiToName: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => {
      const m = num(a, 'midiToName')
      if (m < 0 || m > 127) throw new ExprError('midiToName 超出 0-127')
      return Note.fromMidi(m) ?? String(m)
    },
  },
  nameToMidi: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => {
      if (typeof a !== 'string') throw new ExprError('nameToMidi 需要字符串')
      return Note.midi(a) ?? -1
    },
  },
  cents: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([f, m]) => {
      const freq = num(f, 'cents')
      const midi = num(m, 'cents')
      if (!(freq > 0)) throw new ExprError('cents 频率必须为正数')
      const target = 440 * Math.pow(2, (midi - 69) / 12)
      return Math.round(1200 * Math.log2(freq / target))
    },
  },
  upper: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => {
      if (typeof a !== 'string') throw new ExprError('upper 需要字符串')
      return a.toUpperCase()
    },
  },
  lower: {
    minArgs: 1,
    maxArgs: 1,
    fn: ([a]) => {
      if (typeof a !== 'string') throw new ExprError('lower 需要字符串')
      return a.toLowerCase()
    },
  },
  append: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([arr, x]) => {
      if (!Array.isArray(arr)) throw new ExprError('append 第一个参数需要数组')
      return [...arr, x]
    },
  },
  concat: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([a, b]) => {
      if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
      if (typeof a === 'string' && typeof b === 'string') return a + b
      throw new ExprError('concat 两个参数需要同为数组或同为字符串')
    },
  },
  contains: {
    minArgs: 2,
    maxArgs: 2,
    fn: ([hay, x]) => {
      if (Array.isArray(hay)) return hay.some((item) => item === x)
      if (typeof hay === 'string' && typeof x === 'string') return hay.includes(x)
      throw new ExprError('contains 需要数组或字符串作为第一个参数')
    },
  },
  join: {
    minArgs: 1,
    maxArgs: 2,
    fn: ([arr, sep]) => {
      if (!Array.isArray(arr)) throw new ExprError('join 需要数组')
      const s = sep === undefined ? '' : String(sep)
      return arr.map((item) => String(item)).join(s)
    },
  },
  slice: {
    minArgs: 2,
    maxArgs: 3,
    fn: ([x, start, end]) => {
      const s = Math.trunc(num(start, 'slice'))
      const e = end === undefined ? undefined : Math.trunc(num(end, 'slice'))
      if (Array.isArray(x)) return x.slice(s, e)
      if (typeof x === 'string') return x.slice(s, e)
      throw new ExprError('slice 需要数组或字符串')
    },
  },
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

const FORBIDDEN_PROPS = new Set(['__proto__', 'prototype', 'constructor'])

function getMember(obj: Json, prop: string, pathDesc: string): Json {
  if (obj === null || typeof obj !== 'object') throw new ExprError(`${pathDesc}: 不能从标量取属性 "${prop}"`)
  if (FORBIDDEN_PROPS.has(prop)) throw new ExprError(`${pathDesc}: 禁止访问 "${prop}"`)
  if (Object.prototype.hasOwnProperty.call(obj, prop)) return (obj as Record<string, Json>)[prop]
  throw new ExprError(`${pathDesc}: 未知属性 "${prop}"`)
}

class Evaluator {
  private steps = 0
  constructor(
    private scope: ExprScope,
    private ctx: ExprContext,
  ) {}

  evalAst(node: Ast): Json {
    if (++this.steps > (this.ctx.stepBudget ?? 1000)) throw new ExprError('表达式求值步数超预算')
    switch (node.k) {
      case 'lit':
        return node.v
      case 'array':
        return node.items.map((item) => this.evalAst(item))
      case 'index': {
        const obj = this.evalAst(node.obj)
        const rawIdx = this.evalAst(node.idx)
        if (typeof rawIdx !== 'number') throw new ExprError('下标必须是数字')
        const idx = Math.trunc(rawIdx)
        if (Array.isArray(obj)) return idx >= 0 && idx < obj.length ? obj[idx] : null
        if (typeof obj === 'string') return idx >= 0 && idx < obj.length ? obj[idx] : null
        throw new ExprError('只能对数组或字符串取下标')
      }
      case 'path': {
        const root = node.parts[0]
        let cur: Json
        if (root === 'event') cur = this.scope.event
        else if (root === 'q') cur = this.scope.q
        else if (root === 'v') cur = this.scope.v
        else throw new ExprError(`未定义的标识符 "${root}"（只允许 event/q/v 开头）`)
        for (let i = 1; i < node.parts.length; i++) {
          cur = getMember(cur, node.parts[i], node.parts.slice(0, i + 1).join('.'))
        }
        return cur
      }
      case 'call': {
        const def = FUNCS[node.name]
        if (!def) throw new ExprError(`未知函数 "${node.name}"（只允许白名单函数）`)
        if (node.args.length < def.minArgs || node.args.length > def.maxArgs)
          throw new ExprError(`${node.name} 参数数量不符`)
        const args = node.args.map((a) => this.evalAst(a))
        if (++this.steps > (this.ctx.stepBudget ?? 1000)) throw new ExprError('表达式求值步数超预算')
        return def.fn(args, this.ctx)
      }
      case 'un': {
        const a = this.evalAst(node.a)
        if (node.op === '!') return !a
        return -num(a, '一元 -')
      }
      case 'tern':
        return this.evalAst(node.c) ? this.evalAst(node.a) : this.evalAst(node.b)
      case 'bin':
        return this.bin(node)
    }
  }

  private bin(node: Extract<Ast, { k: 'bin' }>): Json {
    const op = node.op
    if (op === '&&') return this.evalAst(node.a) ? this.evalAst(node.b) : false
    if (op === '||') {
      const a = this.evalAst(node.a)
      return a ? a : this.evalAst(node.b)
    }
    const a = this.evalAst(node.a)
    const b = this.evalAst(node.b)
    switch (op) {
      case '+':
        if (typeof a === 'string' || typeof b === 'string') return String(a) + String(b)
        return num(a, '+') + num(b, '+')
      case '-':
        return num(a, '-') - num(b, '-')
      case '*':
        return num(a, '*') * num(b, '*')
      case '/': {
        const d = num(b, '/')
        if (d === 0) throw new ExprError('除以零')
        return num(a, '/') / d
      }
      case '%': {
        const d = num(b, '%')
        if (d === 0) throw new ExprError('取模为零')
        return num(a, '%') % d
      }
      case '==':
        return a === b
      case '!=':
        return a !== b
      case '<':
        return num(a, '<') < num(b, '<')
      case '<=':
        return num(a, '<=') <= num(b, '<=')
      case '>':
        return num(a, '>') > num(b, '>')
      case '>=':
        return num(a, '>=') >= num(b, '>=')
      default:
        throw new ExprError(`未知运算符 ${op}`)
    }
  }
}

/** 编译期解析（装载关卡时调用，提前暴露语法错误） */
export function compileExpr(src: string): (scope: ExprScope, ctx?: ExprContext) => Json {
  const ast = parseExpr(src)
  return (scope, ctx) => new Evaluator(scope, ctx ?? {}).evalAst(ast)
}

export function evalExpr(src: string, scope: ExprScope, ctx?: ExprContext): Json {
  return compileExpr(src)(scope, ctx)
}
