// exprBridge 纯函数单测：表达式 ↔ 结构化部件双向转换（3-5 节点友好化的地基）
import { describe, expect, it } from 'vitest'
import {
  argViewToArgs,
  argsToArgView,
  condToExpr,
  exprToCond,
  exprToOperand,
  operandToExpr,
  paramDefaultExpr,
  parseCommandParams,
  splitObjectLiteral,
} from './exprBridge'

describe('exprToOperand / operandToExpr', () => {
  it('字面量三态：数字 / 文本 / 布尔', () => {
    expect(exprToOperand('42')).toEqual({ mode: 'number', value: 42 })
    expect(exprToOperand('-3.5')).toEqual({ mode: 'number', value: -3.5 })
    expect(exprToOperand(`'你好'`)).toEqual({ mode: 'string', value: '你好' })
    expect(exprToOperand('"hi"')).toEqual({ mode: 'string', value: 'hi' })
    expect(exprToOperand('true')).toEqual({ mode: 'boolean', value: true })
    expect(exprToOperand('false')).toEqual({ mode: 'boolean', value: false })
  })

  it('引用：变量与 event/q 路径', () => {
    expect(exprToOperand('v.score')).toEqual({ mode: 'ref', path: 'v.score' })
    expect(exprToOperand('event.midi')).toEqual({ mode: 'ref', path: 'event.midi' })
    expect(exprToOperand('q.data.seq')).toEqual({ mode: 'ref', path: 'q.data.seq' })
    // 未声明变量也保留为 ref（lint 负责提示），切节点不丢原文
    expect(exprToOperand('v.ghost')).toEqual({ mode: 'ref', path: 'v.ghost' })
  })

  it('复杂表达式回落 advanced 且原文保留', () => {
    const src = `v.score + len(v.taps)`
    expect(exprToOperand(src)).toEqual({ mode: 'advanced', source: src })
    expect(exprToOperand('1 +')).toEqual({ mode: 'advanced', source: '1 +' })
    expect(operandToExpr({ mode: 'advanced', source: src })).toBe(src)
  })

  it('操作数往返恒等', () => {
    for (const src of ['42', '"hi"', 'true', 'v.score', 'event.midi']) {
      expect(operandToExpr(exprToOperand(src))).toBe(src.trim())
    }
    expect(operandToExpr(exprToOperand(' v.score '))).toBe('v.score')
  })

  it('单引号字符串规范化为双引号（值不变，源文本改写属预期行为——评审 P2-3 记录）', () => {
    expect(operandToExpr(exprToOperand("'你好'"))).toBe('"你好"')
  })
})

describe('exprToCond / condToExpr', () => {
  it('比较条件拆解与重组', () => {
    const c = exprToCond('v.score >= 10')
    expect(c).toEqual({
      mode: 'compare',
      left: { mode: 'ref', path: 'v.score' },
      op: '>=',
      right: { mode: 'number', value: 10 },
    })
    expect(condToExpr(c)).toBe('v.score >= 10')
  })

  it('比较符识别：双字符优先不被单字符吃掉', () => {
    expect(exprToCond('v.a != 1')).toMatchObject({ op: '!=' })
    expect(exprToCond('v.a <= 2')).toMatchObject({ op: '<=' })
    expect(exprToCond('v.a < 3')).toMatchObject({ op: '<' })
    expect(exprToCond(`'a=b' == 'x'`)).toMatchObject({ left: { mode: 'string', value: 'a=b' }, op: '==' })
  })

  it('真值条件：裸变量 / 布尔 / 复杂表达式', () => {
    expect(exprToCond('v.started')).toEqual({ mode: 'truthy', operand: { mode: 'ref', path: 'v.started' } })
    expect(exprToCond('true')).toEqual({ mode: 'truthy', operand: { mode: 'boolean', value: true } })
    const c = exprToCond('v.a && v.b')
    expect(c.mode).toBe('truthy')
    expect(condToExpr(c)).toBe('v.a && v.b')
  })

  it('语法错误保留原文（高级模式兜底）', () => {
    expect(exprToCond('v.a >')).toEqual({ mode: 'advanced', source: 'v.a >' })
    expect(condToExpr({ mode: 'advanced', source: 'v.a >' })).toBe('v.a >')
  })

  it('顶层含 &&/||/?: 不拆比较（评审 P2-2：分组与真实 AST 一致）', () => {
    const or = exprToCond('v.a == 1 || v.b == 2')
    expect(or.mode).toBe('truthy') // 整体作为真值判断，操作数落 advanced 保原文
    expect(condToExpr(or)).toBe('v.a == 1 || v.b == 2')
    const ternary = exprToCond('x > 0 ? 1 : 0')
    expect(ternary.mode).toBe('truthy')
    expect(condToExpr(ternary)).toBe('x > 0 ? 1 : 0')
    // 括号内的 && 不影响比较拆分
    expect(exprToCond('(v.a && v.b) == 1')).toMatchObject({ mode: 'compare', op: '==' })
  })
})

describe('splitObjectLiteral / args 视图', () => {
  it('对象字面量拆键值（值源文本保留）', () => {
    expect(splitObjectLiteral("{ text: '答对了！', tone: 'success' }")).toEqual([
      { key: 'text', source: `'答对了！'` },
      { key: 'tone', source: `'success'` },
    ])
    expect(splitObjectLiteral('{}')).toEqual([])
    expect(splitObjectLiteral('{n: v.score + 1}')).toEqual([{ key: 'n', source: 'v.score + 1' }])
    // 引号内逗号不被切分
    expect(splitObjectLiteral(`{ a: 'x,y', b: 2 }`)).toEqual([
      { key: 'a', source: `'x,y'` },
      { key: 'b', source: '2' },
    ])
  })

  it('非对象字面量返回 null', () => {
    expect(splitObjectLiteral('5')).toBeNull()
    expect(splitObjectLiteral('{a}')).toBeNull()
    expect(splitObjectLiteral('{a: }')).toBeNull()
    expect(splitObjectLiteral('{a: 1')).toBeNull()
  })

  it('args 视图：无参 / 对象 / 高级 三态往返', () => {
    expect(argsToArgView([])).toEqual({ mode: 'none' })
    expect(argViewToArgs({ mode: 'none' })).toEqual([])
    const obj = argsToArgView(["{enabled: false}"])
    expect(obj).toEqual({ mode: 'object', entries: [{ key: 'enabled', source: 'false' }] })
    expect(argViewToArgs(obj)).toEqual(['{ enabled: false }'])
    expect(argsToArgView(['5'])).toEqual({ mode: 'advanced', sources: ['5'] })
    expect(argViewToArgs({ mode: 'advanced', sources: ['5', '6'] })).toEqual(['5', '6'])
    // 空对象保持对象形态（用户显式选了按名传参）
    expect(argViewToArgs({ mode: 'object', entries: [] })).toEqual(['{}'])
  })
})

describe('parseCommandParams（契约签名解析）', () => {
  it('无参数 / 参数表 / 未知签名', () => {
    expect(parseCommandParams('无参数')).toEqual([])
    expect(parseCommandParams(undefined)).toBeNull()
    expect(parseCommandParams('{ text: string, tone?: "info"|"success"|"error" }')).toEqual([
      { name: 'text', optional: false, typeDoc: 'string' },
      { name: 'tone', optional: true, typeDoc: '"info"|"success"|"error"' },
    ])
    expect(parseCommandParams('{ notes: Note[], tempo?: number }')).toEqual([
      { name: 'notes', optional: false, typeDoc: 'Note[]' },
      { name: 'tempo', optional: true, typeDoc: 'number' },
    ])
    expect(parseCommandParams('随便什么')).toBeNull()
  })

  it('事件负载描述也能解析出字段（供 event.* 路径候选）', () => {
    expect(parseCommandParams('{ index: number, value: string }')?.map((p) => p.name)).toEqual(['index', 'value'])
    expect(parseCommandParams('无负载')).toBeNull()
  })

  it('按类型猜默认值', () => {
    expect(paramDefaultExpr({ name: 'a', optional: false, typeDoc: 'number(midi)' })).toBe('0')
    expect(paramDefaultExpr({ name: 'a', optional: false, typeDoc: 'boolean' })).toBe('false')
    expect(paramDefaultExpr({ name: 'a', optional: false, typeDoc: '"correct"|"wrong"' })).toBe('""')
  })
})
