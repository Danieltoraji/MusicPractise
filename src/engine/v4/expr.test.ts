import { describe, expect, it } from 'vitest'
import { ExprError, parseExpr } from '../expr'
import {
  BEHAVIOR_ROOTS,
  FLOW_ROOTS,
  SHELL_BINDING_ROOTS,
  SURFACE_BINDING_ROOTS,
  checkV4Expr,
  clearV4ExprCache,
  collectExprCalls,
  collectExprRoots,
  compileV4,
  evalV4,
  exprRoots,
  parsePath,
  readEnvPath,
  rootsOfLayer,
  validateWriteTarget,
  writeEnvPath,
} from './expr'

describe('v4 expr：根集合与 AST 静态分析', () => {
  it('rootsOfLayer 按层返回显式根集合', () => {
    expect(rootsOfLayer('flow')).toEqual(['v', 'local', 'run'])
    expect(rootsOfLayer('behavior')).toEqual(BEHAVIOR_ROOTS)
    expect(rootsOfLayer('surface-binding')).toEqual(SURFACE_BINDING_ROOTS)
    expect(rootsOfLayer('shell-binding')).toEqual(SHELL_BINDING_ROOTS)
    expect(SHELL_BINDING_ROOTS).not.toContain('q')
    expect(SURFACE_BINDING_ROOTS).not.toContain('event')
    expect(BEHAVIOR_ROOTS).toContain('event')
  })

  it('exprRoots/collectExprRoots 提取路径根（去重、保序）', () => {
    expect(exprRoots('v.score + q.scoring')).toEqual(['v', 'q'])
    expect(exprRoots('q.score + v.score')).toEqual(['q', 'v'])
    expect(exprRoots('max(v.a, q.b) + v.a')).toEqual(['v', 'q'])
    expect(exprRoots("stateOf('choice','row_01','answered')")).toEqual([])
    expect(exprRoots('42')).toEqual([])
    expect(exprRoots("{ a: v.x, b: [q.y] }")).toEqual(['v', 'q'])
    expect(collectExprRoots(parseExpr('run.total > 0 ? local.i : args.n'))).toEqual([
      'run',
      'local',
      'args',
    ])
  })

  it('collectExprCalls 提取函数名', () => {
    expect(collectExprCalls(parseExpr('max(v.a, min(q.b, q.c)) + len(run.questions)'))).toEqual([
      'max',
      'min',
      'len',
    ])
  })
})

describe('v4 expr：多根求值', () => {
  it('按 env 解析路径；未声明根/未知属性/缺根均抛可读错误', () => {
    const env = { v: { score: 10 }, q: { scoring: 5 } }
    expect(evalV4('v.score + q.scoring', env)).toBe(15)
    expect(() => evalV4('v.score + q.scoring', env, FLOW_ROOTS)).toThrow(/本层允许/)
    expect(() => evalV4('v.missing', env)).toThrow(/未知属性/)
    expect(() => evalV4('run.total', env, FLOW_ROOTS)).toThrow(/缺少该作用域根/)
  })

  it('compileV4 按源码+根集合缓存', () => {
    clearV4ExprCache()
    expect(compileV4('v.x + 1')).toBe(compileV4('v.x + 1'))
    expect(compileV4('v.x + 1')).not.toBe(compileV4('q.x + 1'))
  })

  it('v4 专用函数：check 按层放行，求值需 ctx 钩子', () => {
    expect(checkV4Expr("stateOf('choice','row_01','answered')", { roots: FLOW_ROOTS, allowV4Functions: true })).toEqual({
      ok: true,
    })
    const denied = checkV4Expr("stateOf('choice','row_01','answered')", { roots: BEHAVIOR_ROOTS })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.message).toMatch(/只能在流程层/)
    const ctx = {
      questionState: (t: string, r: string, f: string) =>
        t === 'choice' && r === 'row_01' && f === 'answered' ? true : null,
      questionContent: (t: string, r: string, f: string) =>
        t === 'choice' && r === 'row_01' && f === 'prompt' ? '题面' : null,
    }
    expect(evalV4("stateOf('choice','row_01','answered')", {}, FLOW_ROOTS, ctx)).toBe(true)
    expect(evalV4("contentOf('choice','row_01','prompt')", {}, FLOW_ROOTS, ctx)).toBe('题面')
    expect(() => evalV4("stateOf('choice','row_01','answered')", {})).toThrow(/只能在流程层/)
  })
})

describe('v4 expr：静态校验', () => {
  it('合法表达式/空表达式通过', () => {
    expect(checkV4Expr('', { roots: FLOW_ROOTS })).toEqual({ ok: true })
    expect(checkV4Expr('v.score >= 10', { roots: FLOW_ROOTS })).toEqual({ ok: true })
    expect(checkV4Expr("len(run.questions) > 0", { roots: FLOW_ROOTS })).toEqual({ ok: true })
  })

  it('语法错误返回可读消息', () => {
    const bad = checkV4Expr('v.score +', { roots: FLOW_ROOTS })
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.message.length).toBeGreaterThan(0)
  })

  it('未知根/未知函数被拒', () => {
    const root = checkV4Expr('foo.bar', { roots: FLOW_ROOTS })
    expect(root.ok).toBe(false)
    if (!root.ok) expect(root.message).toMatch(/本层允许/)
    const fn = checkV4Expr('nope(v.score)', { roots: FLOW_ROOTS })
    expect(fn.ok).toBe(false)
    if (!fn.ok) expect(fn.message).toMatch(/未知函数/)
  })
})

describe('v4 expr：写入路径与权限', () => {
  it('parsePath 只接受 根+1~2 段合法标识符', () => {
    expect(parsePath('v.score')).toEqual({ root: 'v', rest: ['score'] })
    expect(parsePath('q.state.answered')).toEqual({ root: 'q', rest: ['state', 'answered'] })
    for (const bad of ['v', 'v.a.b.c', 'v..x', 'v.9x', 'v.a-b', '']) {
      expect(() => parsePath(bad)).toThrow(ExprError)
    }
  })

  it('readEnvPath 读取嵌套值，缺根/缺属性/标量取属性抛错', () => {
    const env = { v: { score: 1 }, q: { state: { answered: true } } }
    expect(readEnvPath(env, 'v.score')).toBe(1)
    expect(readEnvPath(env, 'q.state.answered')).toBe(true)
    expect(() => readEnvPath(env, 'run.total')).toThrow(/未定义的作用域根/)
    expect(() => readEnvPath(env, 'v.nope')).toThrow(/未知属性/)
    expect(() => readEnvPath(env, 'v.score.x')).toThrow(/标量/)
  })

  it('writeEnvPath 写入已初始化对象；未初始化中间对象/原型键被拒', () => {
    const env: Record<string, unknown> = { v: { score: 1 }, local: {}, q: { state: { answered: false } } }
    writeEnvPath(env as never, 'v.score', 5)
    writeEnvPath(env as never, 'q.state.answered', true)
    expect(readEnvPath(env as never, 'v.score')).toBe(5)
    expect(readEnvPath(env as never, 'q.state.answered')).toBe(true)
    expect(() => writeEnvPath(env as never, 't.combo', 1)).toThrow(/未定义的作用域根/)
    expect(() => writeEnvPath(env as never, 'v.__proto__', {})).toThrow(/禁止写入/)
  })

  it('validateWriteTarget：flow 只允许声明的 v.*/local.*', () => {
    const decl = { vars: ['score'], locals: ['i'] }
    expect(validateWriteTarget('v.score', 'flow', decl)).toBeNull()
    expect(validateWriteTarget('local.i', 'flow', decl)).toBeNull()
    expect(validateWriteTarget('v.other', 'flow', decl)).toMatch(/未声明的 run 变量/)
    expect(validateWriteTarget('local.j', 'flow', decl)).toMatch(/未声明的局部变量/)
    expect(validateWriteTarget('q.state.answered', 'flow', decl)).toMatch(/不能写/)
    expect(validateWriteTarget('v', 'flow', decl)).not.toBeNull()
  })

  it('validateWriteTarget：behavior 只允许 q.state/t/local', () => {
    const decl = { qState: ['answered'], typeState: ['combo'], locals: ['tmp'] }
    expect(validateWriteTarget('q.state.answered', 'behavior', decl)).toBeNull()
    expect(validateWriteTarget('t.combo', 'behavior', decl)).toBeNull()
    expect(validateWriteTarget('local.tmp', 'behavior', decl)).toBeNull()
    expect(validateWriteTarget('q.state.other', 'behavior', decl)).toMatch(/未声明的实例态字段/)
    expect(validateWriteTarget('t.other', 'behavior', decl)).toMatch(/未声明的题型态字段/)
    expect(validateWriteTarget('q.content', 'behavior', decl)).toMatch(/只能写 q.state/)
    expect(validateWriteTarget('v.score', 'behavior', decl)).toMatch(/不能写/)
  })
})
