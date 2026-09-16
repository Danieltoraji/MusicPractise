import { describe, expect, it } from 'vitest'
import { evalExpr, ExprError } from './expr'

const base = { event: {}, q: null, v: {} } as const

describe('表达式求值', () => {
  it('算术与优先级', () => {
    expect(evalExpr('1 + 2 * 3', base)).toBe(7)
    expect(evalExpr('(1 + 2) * 3', base)).toBe(9)
    expect(evalExpr('10 % 3', base)).toBe(1)
    expect(evalExpr('-2 + 5', base)).toBe(3)
  })

  it('字符串拼接与比较', () => {
    expect(evalExpr("'得分: ' + 12", base)).toBe('得分: 12')
    expect(evalExpr('"a" + "b"', base)).toBe('ab')
    expect(evalExpr('3 == 3', base)).toBe(true)
    expect(evalExpr('3 != 3', base)).toBe(false)
  })

  it('逻辑与三元', () => {
    expect(evalExpr('true && false', base)).toBe(false)
    expect(evalExpr('!false', base)).toBe(true)
    expect(evalExpr("false ? 'a' : 'b'", base)).toBe('b')
    expect(evalExpr("0 ? 'a' : 'b'", base)).toBe('b')
    expect(evalExpr("'x' ? 1 : 2", base)).toBe(1)
    expect(evalExpr("1 < 2 ? 'lt' : 'gte'", base)).toBe('lt')
  })

  it('作用域与成员访问', () => {
    const scope = {
      event: { midi: 64, name: 'E4' },
      q: { data: { answerMidi: 64 }, scoring: { max: 10 } },
      v: { score: 5 },
    }
    expect(evalExpr('event.midi == q.data.answerMidi', scope)).toBe(true)
    expect(evalExpr('v.score + q.scoring.max', scope)).toBe(15)
    expect(evalExpr('len(q.data) > 0', scope)).toBe(true)
  })

  it('白名单函数', () => {
    expect(evalExpr('abs(0 - 3)', base)).toBe(3)
    expect(evalExpr('max(1, 9, 4)', base)).toBe(9)
    expect(evalExpr('round(1.6)', base)).toBe(2)
    expect(evalExpr('midiToName(60)', base)).toBe('C4')
    expect(evalExpr('nameToMidi("A4")', base)).toBe(69)
    expect(evalExpr('cents(440, 69)', base)).toBe(0)
    expect(evalExpr('cents(466.16, 69)', base)).toBe(100)
    const ri = evalExpr('randomInt(2, 2)', base)
    expect(ri).toBe(2)
  })

  it('安全边界：拒绝作用域外标识符', () => {
    expect(() => evalExpr('foo + 1', base)).toThrow(ExprError)
    expect(() => evalExpr('globalThis', base)).toThrow(ExprError)
  })

  it('安全边界：拒绝危险属性与原型逃逸', () => {
    const evil = { constructor: { constructor: () => null } } as unknown as Record<string, never>
    expect(() => evalExpr('event.constructor', { ...base, event: evil })).toThrow(ExprError)
    expect(() => evalExpr('v.__proto__', { ...base, v: {} })).toThrow(ExprError)
  })

  it('安全边界：拒绝赋值/循环/未知函数', () => {
    expect(() => evalExpr('v.score = 5', base)).toThrow(ExprError)
    expect(() => evalExpr('while (1) {}', base)).toThrow(ExprError)
    expect(() => evalExpr('fetch("http://x")', base)).toThrow(ExprError)
  })

  it('语法错误在解析期暴露', () => {
    expect(() => evalExpr("1 +", base)).toThrow(ExprError)
    expect(() => evalExpr("'abc", base)).toThrow(ExprError)
    expect(() => evalExpr('1 2', base)).toThrow(ExprError)
  })

  it('步数预算', () => {
    expect(() => evalExpr('1 + 1 + 1 + 1', base, { stepBudget: 3 })).toThrow(/超预算/)
  })
})
