/**
 * G15（docs/40 / docs/44 R29）：CSS 顶层「同选择器 + 完全相同声明」重复规则守卫。
 *
 * R29 审计：全文件 1020 条顶层规则中仅 3 组「选择器与声明完全一致」的重复（.badge.pass /
 * .ai-plan-run / .docs-article p,li），已删除；其余 56 组同名选择器多属**属性冲突**（不同值/
 * 不同用途），删除需视觉矩阵护航，留作残余（docs/44 §16）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

interface Rule {
  sel: string
  body: string
}

/** 顶层（非 @media/@keyframes）规则解析：按花括号配对，忽略注释与空白差异 */
function topLevelRules(source: string): Rule[] {
  const rules: Rule[] = []
  let i = 0
  while (i < source.length) {
    const open = source.indexOf('{', i)
    if (open < 0) break
    let depth = 0
    let j = open
    for (; j < source.length; j += 1) {
      if (source[j] === '{') depth += 1
      else if (source[j] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const rawSelector = source.slice(i, open)
    if (!rawSelector.includes('@')) {
      const sel = rawSelector.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ')
      const body = source.slice(open + 1, j).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
      if (sel && body) rules.push({ sel, body })
    }
    i = j + 1
  }
  return rules
}

describe('G15 CSS 重复规则守卫（docs/44 R29）', () => {
  it('不存在「同选择器 + 完全相同声明」的顶层重复规则', () => {
    const rules = topLevelRules(css)
    expect(rules.length, '顶层规则数异常（CSS 结构被破坏？）').toBeGreaterThan(900)
    const seen = new Map<string, number>()
    for (const r of rules) {
      const key = `${r.sel}\u0000${r.body}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k.split('\u0000')[0])
    expect(dups, `存在完全重复规则：${dups.join(' | ')}`).toEqual([])
  })

  it('花括号平衡（删除重复规则后结构完整）', () => {
    const open = (css.match(/\{/g) ?? []).length
    const close = (css.match(/\}/g) ?? []).length
    expect(close).toBe(open)
  })
})
