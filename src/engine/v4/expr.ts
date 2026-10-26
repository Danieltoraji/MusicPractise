/**
 * v4 表达式层（docs/53 §8）：在多根环境（ExprEnv）上求值，并补静态校验/写入路径工具。
 *
 * - 复用 src/engine/expr.ts 的解析器/白名单/步数预算/原型防护（compileEnvExpr）；
 * - 根集合按层显式声明（Flow / Behavior / shell 绑定 / surface 绑定），不隐式回退；
 * - 静态校验返回可读中文（编辑器实时提示与 lint 共用），不求值；
 * - 写入目标校验 + read/write 路径工具（运行时 assign 节点与测试共用）。
 */
import {
  ExprError,
  compileEnvExpr,
  isKnownExprFunction,
  isV4OnlyExprFunction,
  parseExpr,
  type Ast,
  type ExprContext,
  type ExprEnv,
  type Json,
} from '../expr'

export type V4Layer = 'flow' | 'behavior' | 'shell-binding' | 'surface-binding'

/** flow main 的作用域根（docs/53 §8.1） */
export const FLOW_ROOTS = ['v', 'local', 'run'] as const
/** 题型行为的作用域根（handler 内额外有 event；由运行时把 event 注入 env 时一并提供） */
export const BEHAVIOR_ROOTS = ['q', 't', 'local', 'args', 'v', 'run', 'event'] as const
/** shell 组件绑定：只读投影 run 变量 */
export const SHELL_BINDING_ROOTS = ['v', 'run'] as const
/** surface 组件绑定：只读投影题内作用域 */
export const SURFACE_BINDING_ROOTS = ['q', 't', 'args', 'v', 'run'] as const

export function rootsOfLayer(layer: V4Layer): readonly string[] {
  switch (layer) {
    case 'flow':
      return FLOW_ROOTS
    case 'behavior':
      return BEHAVIOR_ROOTS
    case 'shell-binding':
      return SHELL_BINDING_ROOTS
    case 'surface-binding':
      return SURFACE_BINDING_ROOTS
  }
}

const IDENT_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const FORBIDDEN_PROPS = new Set(['__proto__', 'prototype', 'constructor'])

// ---------------------------------------------------------------------------
// AST 静态分析
// ---------------------------------------------------------------------------

function visitAst(node: Ast, onPath: (root: string) => void, onCall: (name: string) => void): void {
  switch (node.k) {
    case 'lit':
      return
    case 'path':
      onPath(node.parts[0])
      return
    case 'array':
      for (const item of node.items) visitAst(item, onPath, onCall)
      return
    case 'obj':
      for (const entry of node.entries) visitAst(entry.value, onPath, onCall)
      return
    case 'index':
      visitAst(node.obj, onPath, onCall)
      visitAst(node.idx, onPath, onCall)
      return
    case 'call':
      onCall(node.name)
      for (const arg of node.args) visitAst(arg, onPath, onCall)
      return
    case 'un':
      visitAst(node.a, onPath, onCall)
      return
    case 'bin':
      visitAst(node.a, onPath, onCall)
      visitAst(node.b, onPath, onCall)
      return
    case 'tern':
      visitAst(node.c, onPath, onCall)
      visitAst(node.a, onPath, onCall)
      visitAst(node.b, onPath, onCall)
      return
  }
}

/** AST 中出现的路径（根 + 段，去重、按出现顺序）；用于按 schema 做静态路径校验 */
export function collectExprPaths(ast: Ast): string[][] {
  const paths: string[][] = []
  const seen = new Set<string>()
  const onPath = (parts: string[]): void => {
    const key = parts.join('.')
    if (seen.has(key)) return
    seen.add(key)
    paths.push(parts)
  }
  const walk = (node: Ast): void => {
    switch (node.k) {
      case 'lit':
        return
      case 'path':
        onPath(node.parts)
        return
      case 'array':
        for (const item of node.items) walk(item)
        return
      case 'obj':
        for (const entry of node.entries) walk(entry.value)
        return
      case 'index':
        walk(node.obj)
        walk(node.idx)
        return
      case 'call':
        for (const arg of node.args) walk(arg)
        return
      case 'un':
        walk(node.a)
        return
      case 'bin':
        walk(node.a)
        walk(node.b)
        return
      case 'tern':
        walk(node.c)
        walk(node.a)
        walk(node.b)
        return
    }
  }
  walk(ast)
  return paths
}

export function exprPaths(src: string): string[][] {
  return collectExprPaths(parseExpr(src))
}

/** AST 中出现的根标识符（去重、按出现顺序） */
export function collectExprRoots(ast: Ast): string[] {
  const roots: string[] = []
  visitAst(
    ast,
    (root) => {
      if (!roots.includes(root)) roots.push(root)
    },
    () => {},
  )
  return roots
}

/** AST 中调用的函数名（去重、按出现顺序） */
export function collectExprCalls(ast: Ast): string[] {
  const names: string[] = []
  visitAst(
    ast,
    () => {},
    (name) => {
      if (!names.includes(name)) names.push(name)
    },
  )
  return names
}

export function exprRoots(src: string): string[] {
  return collectExprRoots(parseExpr(src))
}

// ---------------------------------------------------------------------------
// 编译缓存 + 求值
// ---------------------------------------------------------------------------

type EnvEvaluator = (env: ExprEnv, ctx?: ExprContext) => Json

const compileCache = new Map<string, EnvEvaluator>()

/** 编译（按源码+根集合缓存）；语法错误在此抛 ExprError */
export function compileV4(src: string, roots?: readonly string[]): EnvEvaluator {
  const key = `${roots ? roots.join('/') : '*'}\u0000${src}`
  const cached = compileCache.get(key)
  if (cached) return cached
  const fn = compileEnvExpr(src, roots)
  compileCache.set(key, fn)
  return fn
}

export function evalV4(
  src: string,
  env: ExprEnv,
  roots?: readonly string[],
  ctx?: ExprContext,
): Json {
  return compileV4(src, roots)(env, ctx)
}

/** 清空表达式编译缓存（测试/热更新用） */
export function clearV4ExprCache(): void {
  compileCache.clear()
}

// ---------------------------------------------------------------------------
// 静态校验（编辑器实时提示 + lint 共用）
// ---------------------------------------------------------------------------

export type V4ExprCheck =
  | { ok: true }
  | { ok: false; code: 'syntax' | 'root' | 'function'; message: string }

export interface V4ExprCheckOptions {
  /** 本层允许的根（FLOW_ROOTS / BEHAVIOR_ROOTS / …） */
  roots: readonly string[]
  /** 是否允许 v4 专用函数（stateOf/contentOf，仅 flow 层） */
  allowV4Functions?: boolean
}

/** 空字符串视为「未提供」，由调用方按字段必填性决定 */
export function checkV4Expr(src: string, opts: V4ExprCheckOptions): V4ExprCheck {
  if (src.trim() === '') return { ok: true }
  let ast: Ast
  try {
    ast = parseExpr(src)
  } catch (err) {
    return { ok: false, code: 'syntax', message: err instanceof Error ? err.message : String(err) }
  }
  const allowed = new Set(opts.roots)
  for (const root of collectExprRoots(ast)) {
    if (!allowed.has(root)) {
      return {
        ok: false,
        code: 'root',
        message: `未定义的标识符 "${root}"（本层允许：${opts.roots.join('/')}）`,
      }
    }
  }
  for (const name of collectExprCalls(ast)) {
    if (!isKnownExprFunction(name)) {
      return { ok: false, code: 'function', message: `未知函数 "${name}"（只允许白名单函数）` }
    }
    if (isV4OnlyExprFunction(name) && !opts.allowV4Functions) {
      return { ok: false, code: 'function', message: `"${name}" 只能在流程层（flow）使用` }
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 写入路径：解析/校验/读写
// ---------------------------------------------------------------------------

export interface PathParts {
  root: string
  /** 路径段（根之后，1~2 段） */
  rest: string[]
}

/** 解析赋值路径（`v.score` / `q.state.answered` / `local.i`）；拒绝空段/非法字符/超深路径 */
export function parsePath(path: string): PathParts {
  const parts = path.split('.')
  if (parts.length < 2 || parts.length > 3) {
    throw new ExprError(`路径必须是 根.字段 或 根.字段.子字段 形式："${path}"`)
  }
  for (const part of parts) {
    if (!IDENT_SEGMENT.test(part)) throw new ExprError(`路径段非法："${part}"（${path}）`)
  }
  return { root: parts[0], rest: parts.slice(1) }
}

export interface DeclaredWriteScopes {
  /** flow：flow.vars 声明的 run 变量名 */
  vars?: readonly string[]
  /** flow/behavior：显式声明的 local.*（调用方应把隐式 resultVar/itemVar 一并放入） */
  locals?: readonly string[]
  /** behavior：type.state 声明的实例态字段 */
  qState?: readonly string[]
  /** behavior：typeState 声明的题型态字段 */
  typeState?: readonly string[]
}

const localDeclError = (path: string, key: string): string =>
  `未声明的局部变量 "local.${key}"（${path}）：请先在变量面板添加或改用已声明变量`

/**
 * 校验 assign 的写入目标（docs/53 §8.1）：
 * - flow：只允许 v.<已声明变量> / local.<已声明局部>
 * - behavior：只允许 q.state.<已声明字段> / t.<已声明字段> / local.<已声明局部>
 */
export function validateWriteTarget(
  path: string,
  layer: 'flow' | 'behavior',
  declared: DeclaredWriteScopes,
): string | null {
  let parsed: PathParts
  try {
    parsed = parsePath(path)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  const { root, rest } = parsed
  const vars = new Set(declared.vars ?? [])
  const locals = new Set(declared.locals ?? [])
  const qState = new Set(declared.qState ?? [])
  const typeState = new Set(declared.typeState ?? [])
  if (layer === 'flow') {
    if (root === 'v') {
      if (rest.length !== 1) return `流程层只能写 v.<变量>（"${path}"）`
      if (!vars.has(rest[0])) return `未声明的 run 变量 "v.${rest[0]}"（${path}）：请先加入变量声明`
      return null
    }
    if (root === 'local') {
      if (rest.length !== 1) return `流程层只能写 local.<变量>（"${path}"）`
      if (!locals.has(rest[0])) return localDeclError(path, rest[0])
      return null
    }
    return `流程层不能写 "${path}"（只允许 v.* / local.*）`
  }
  if (root === 'q') {
    if (rest.length !== 2 || rest[0] !== 'state') return `行为层只能写 q.state.<字段>（"${path}"）`
    if (!qState.has(rest[1])) return `未声明的实例态字段 "q.state.${rest[1]}"（${path}）：请在题型「状态参数」中声明`
    return null
  }
  if (root === 't') {
    if (rest.length !== 1) return `行为层只能写 t.<字段>（"${path}"）`
    if (!typeState.has(rest[0])) return `未声明的题型态字段 "t.${rest[0]}"（${path}）：请在题型「状态参数」中声明`
    return null
  }
  if (root === 'local') {
    if (rest.length !== 1) return `行为层只能写 local.<变量>（"${path}"）`
    if (!locals.has(rest[0])) return localDeclError(path, rest[0])
    return null
  }
  return `行为层不能写 "${path}"（只允许 q.state.* / t.* / local.*）`
}

/** 读取路径（只读用途：查看/测试）；不写入 */
export function readEnvPath(env: ExprEnv, path: string): Json {
  const { root, rest } = parsePath(path)
  if (!Object.prototype.hasOwnProperty.call(env, root)) {
    throw new ExprError(`未定义的作用域根 "${root}"`)
  }
  let cur: Json = env[root]
  let desc = root
  for (const part of rest) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      throw new ExprError(`${desc}: 不能从标量取属性 "${part}"`)
    }
    if (FORBIDDEN_PROPS.has(part)) throw new ExprError(`${desc}: 禁止访问 "${part}"`)
    if (!Object.prototype.hasOwnProperty.call(cur, part)) throw new ExprError(`${desc}: 未知属性 "${part}"`)
    cur = (cur as Record<string, Json>)[part]
    desc += `.${part}`
  }
  return cur
}

/** 写入路径（运行时 assign 使用；中间对象必须已存在——由会话按声明初始化） */
export function writeEnvPath(env: ExprEnv, path: string, value: Json): void {
  const { root, rest } = parsePath(path)
  if (!Object.prototype.hasOwnProperty.call(env, root)) {
    throw new ExprError(`未定义的作用域根 "${root}"`)
  }
  let cur: Json = env[root]
  let desc = root
  for (let i = 0; i < rest.length - 1; i++) {
    const part = rest[i]
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) {
      throw new ExprError(`${desc}: 不能从标量取属性 "${part}"`)
    }
    if (FORBIDDEN_PROPS.has(part)) throw new ExprError(`${desc}: 禁止访问 "${part}"`)
    if (!Object.prototype.hasOwnProperty.call(cur, part)) {
      throw new ExprError(`${desc}: 未初始化的作用域对象 "${part}"（应在运行开始时初始化）`)
    }
    cur = (cur as Record<string, Json>)[part]
    desc += `.${part}`
  }
  const last = rest[rest.length - 1]
  if (FORBIDDEN_PROPS.has(last)) throw new ExprError(`${desc}: 禁止写入 "${last}"`)
  ;(cur as Record<string, Json>)[last] = value
}
