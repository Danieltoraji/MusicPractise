/**
 * 表达式 ↔ 结构化编辑部件 的双向桥（3-5 节点友好化）。
 *
 * 目标：节点图里用户不做「写代码」——字面量走类型化控件（数字/文本/开关），
 * 引用走下拉选择（变量 v.*、事件负载 event.*），表达式输入只作高级兜底。
 * 桥全部是纯函数：解析失败一律回落 advanced 并保留原文，任何编辑都不丢数据。
 */
import { parseExpr } from '../../engine/expr'

// ---------------------------------------------------------------------------
// 操作数（assign 值 / call 参数值 / 条件两侧 / wait 时长 …共用）
// ---------------------------------------------------------------------------

export type Operand =
  | { mode: 'number'; value: number }
  | { mode: 'string'; value: string }
  | { mode: 'boolean'; value: boolean }
  /** 点路径引用：v.score / event.midi / q.data.x */
  | { mode: 'ref'; path: string }
  /** 不可结构化的表达式：原文保留 */
  | { mode: 'advanced'; source: string }

export interface BridgeCtx {
  /** 已声明变量名（v 选择器候选） */
  varNames: string[]
  /** 事件负载/题目路径候选（event.midi、q.data.x …） */
  refPaths: string[]
}

export function exprToOperand(src: string): Operand {
  const text = src.trim()
  try {
    const ast = parseExpr(text)
    if (ast.k === 'lit') {
      if (typeof ast.v === 'number') return { mode: 'number', value: ast.v }
      if (typeof ast.v === 'string') return { mode: 'string', value: ast.v }
      if (typeof ast.v === 'boolean') return { mode: 'boolean', value: ast.v }
    }
    // 一元负号 + 数字字面量 → 负数
    if (ast.k === 'un' && ast.op === '-' && ast.a.k === 'lit' && typeof ast.a.v === 'number') {
      return { mode: 'number', value: -ast.a.v }
    }
    if (ast.k === 'path' && ast.parts.length >= 2) {
      const full = ast.parts.join('.')
      const root = ast.parts[0]
      if (root === 'v' && ast.parts.length === 2) return { mode: 'ref', path: full }
      if ((root === 'event' || root === 'q') && ast.parts.slice(1).every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p))) {
        return { mode: 'ref', path: full }
      }
    }
  } catch {
    // 语法错误也回落 advanced：原文交给高级输入框（带实时校验）呈现
  }
  return { mode: 'advanced', source: text }
}

export function operandToExpr(op: Operand): string {
  switch (op.mode) {
    case 'number':
      return String(op.value)
    case 'string':
      return JSON.stringify(op.value)
    case 'boolean':
      return op.value ? 'true' : 'false'
    case 'ref':
      return op.path
    case 'advanced':
      return op.source
  }
}

// ---------------------------------------------------------------------------
// 条件（branch / loop-while）
// ---------------------------------------------------------------------------

export const CMP_OPS = ['==', '!=', '>=', '<=', '>', '<'] as const
export type CmpOp = (typeof CMP_OPS)[number]

export type Cond =
  | { mode: 'compare'; left: Operand; op: CmpOp; right: Operand }
  | { mode: 'truthy'; operand: Operand }
  | { mode: 'advanced'; source: string }

/** 在深度 0、引号外寻找第一个比较运算符（双字符优先，避免 > 吃掉 >=） */
function splitCompare(text: string): { left: string; op: CmpOp; right: string } | null {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      continue
    }
    if (depth !== 0) continue
    for (const op of CMP_OPS) {
      if (!text.startsWith(op, i)) continue
      const left = text.slice(0, i).trim()
      const right = text.slice(i + op.length).trim()
      if (left && right) return { left, op, right }
      return null // 比较号一侧为空 = 病态，交高级模式
    }
  }
  return null
}

/** 顶层（深度 0、引号外）是否含 &&/||/?:——有的话不做比较拆分（评审 P2-2：避免 `a == 1 || b == 2` 被错误分组） */
function hasTopLevelLogical(text: string): boolean {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++
      continue
    }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth--
      continue
    }
    if (depth !== 0) continue
    if ((ch === '&' && text[i + 1] === '&') || (ch === '|' && text[i + 1] === '|') || ch === '?') return true
  }
  return false
}

export function exprToCond(src: string): Cond {
  const text = src.trim()
  try {
    parseExpr(text)
  } catch {
    return { mode: 'advanced', source: text }
  }
  const parts = hasTopLevelLogical(text) ? null : splitCompare(text)
  if (parts) {
    return {
      mode: 'compare',
      left: exprToOperand(parts.left),
      op: parts.op,
      right: exprToOperand(parts.right),
    }
  }
  return { mode: 'truthy', operand: exprToOperand(text) }
}

export function condToExpr(c: Cond): string {
  if (c.mode === 'compare') return `${operandToExpr(c.left)} ${c.op} ${operandToExpr(c.right)}`
  if (c.mode === 'truthy') return operandToExpr(c.operand)
  return c.source
}

// ---------------------------------------------------------------------------
// call 参数（引擎约定：args[0] 是一个对象字面量，即命令的 argv）
// ---------------------------------------------------------------------------

export interface KvEntry {
  key: string
  /** 值的表达式源文本（UI 层再经 OperandPicker 结构化） */
  source: string
}

/** 引号/括号深度感知的顶层逗号切分；括号不配对返回 null */
function splitTopLevel(src: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      cur += ch
      if (ch === '\\') {
        cur += src[i + 1] ?? ''
        i++
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++
      cur += ch
      continue
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--
      cur += ch
      continue
    }
    if (ch === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (depth !== 0 || quote !== null) return null
  parts.push(cur)
  return parts
}

/** 把 `{ k1: v1, k2: v2 }` 拆成键值对；不是对象字面量/键非法/解析失败 → null */
export function splitObjectLiteral(src: string): KvEntry[] | null {
  const t = src.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return null
  const raw = splitTopLevel(t.slice(1, -1))
  if (raw === null) return null
  if (raw.length === 1 && raw[0].trim() === '') return []
  const entries: KvEntry[] = []
  for (const part of raw) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/.exec(part.trim())
    if (!m) return null
    entries.push({ key: m[1], source: m[2].trim() })
  }
  try {
    parseExpr(`{ ${entries.map((e) => `${e.key}: ${e.source}`).join(', ')} }`)
  } catch {
    return null
  }
  return entries
}

export type ArgView =
  | { mode: 'none' }
  | { mode: 'object'; entries: KvEntry[] }
  /** 非对象形态的参数（如纯表达式），按原样保留 */
  | { mode: 'advanced'; sources: string[] }

export function argsToArgView(args: unknown): ArgView {
  if (!Array.isArray(args) || args.length === 0) return { mode: 'none' }
  if (typeof args[0] === 'string') {
    const entries = splitObjectLiteral(args[0])
    if (entries) return { mode: 'object', entries }
  }
  return { mode: 'advanced', sources: args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))) }
}

export function argViewToArgs(v: ArgView): string[] {
  if (v.mode === 'none') return []
  if (v.mode === 'object') {
    if (v.entries.length === 0) return ['{}']
    return [`{ ${v.entries.map((e) => `${e.key}: ${e.source}`).join(', ')} }`]
  }
  return v.sources
}

// ---------------------------------------------------------------------------
// 契约命令签名解析（`{ text: string, tone?: "info" }` → 参数名清单，供键建议与补全）
// ---------------------------------------------------------------------------

export interface ParamDef {
  name: string
  optional: boolean
  typeDoc: string
}

export function parseCommandParams(doc: string | undefined): ParamDef[] | null {
  if (doc === undefined) return null
  const t = doc.trim()
  if (t === '' || t === '无参数' || t === '无') return []
  if (!(t.startsWith('{') && t.endsWith('}'))) return null
  const raw = splitTopLevel(t.slice(1, -1))
  if (raw === null) return null
  if (raw.length === 1 && raw[0].trim() === '') return []
  const defs: ParamDef[] = []
  for (const part of raw) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?\s*:\s*(.+)$/.exec(part.trim())
    if (!m) return null
    defs.push({ name: m[1], optional: m[2] === '?', typeDoc: m[3].trim() })
  }
  return defs
}

/** 按契约类型猜一个字面量默认值（补全参数按钮用） */
export function paramDefaultExpr(def: ParamDef): string {
  if (/boolean/i.test(def.typeDoc)) return 'false'
  if (/number|midi|int\b/i.test(def.typeDoc)) return '0'
  return '""'
}
