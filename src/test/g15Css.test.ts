/**
 * G15（docs/40 / docs/44 R29–R34）：CSS 顶层重复/死声明/死类样式守卫。
 *
 * - R29：删除「同选择器 + 完全相同声明」的重复规则（1020→1017 条顶层规则），零完全重复；
 * - R30：删除「同选择器、被后置规则完全覆盖」的 60 条死声明（非 !important、非 @media），
 *   本守卫重算同一分析并要求归零——新增同名覆盖规则时必须先清理旧声明，避免死代码回涨；
 * - R32：删除 `.level-canvas` 整条死规则（宽高/定位被 LevelStage 内联 style 与 `.stage-canvas` 完全覆盖）；
 * - R34：删除 11 个在 src/ 中完全未被引用的死类样式（rules-editor/rule-card/rule-head/action-list/
 *   action-add/gevents/gdb-preset/ai-mode-chip/library-actions/box-type/docs-callout-warn）；
 *   本守卫反向扫描 CSS 类名并要求「每个静态类名在 src/ 中出现」——动态拼接类名前缀白名单见 DYNAMIC_PREFIXES。
 * 残余：56 组同名选择器中的**不同属性/不同用途**冲突（如 base 与 .ge-dark/媒体查询），
 * 需人工分类 + 视觉矩阵，未在本守卫范围内。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
const levelStageV4 = readFileSync(new URL('../runtime/v4/LevelStageV4.tsx', import.meta.url), 'utf8')

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`
    if (statSync(path).isDirectory()) collectSourceFiles(path, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}
const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url))
const SRC_TEXT = collectSourceFiles(SRC_ROOT)
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

/** CSS 类名由代码动态拼接的前缀（模板字符串），无法按字面量出现在源码中 */
const DYNAMIC_PREFIXES = ['react-flow__', 'bar-', 'tone-', 'st-', 'gedge-', 'skin-preview-']

interface Rule {
  sel: string
  body: string
  /** 非 important 的声明属性名 */
  props: string[]
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
      const bodyRaw = source.slice(open + 1, j)
      const body = bodyRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim()
      const props = bodyRaw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split(';')
        .map((part) => part.trim())
        .filter((part) => part.includes(':') && !/!\s*important/i.test(part))
        .map((part) => part.slice(0, part.indexOf(':')).trim())
        .filter(Boolean)
      if (sel && body) rules.push({ sel, body, props })
    }
    i = j + 1
  }
  return rules
}

describe('G15 CSS 重复/死声明守卫（docs/44 R29–R30）', () => {
  it('不存在「同选择器 + 完全相同声明」的顶层重复规则', () => {
    const rules = topLevelRules(css)
    // W9 删除 v3 死类规则后顶层规则数下降（原本 ≥900）；阈值随之下调，仍防止「结构被破坏/大段误删」
    expect(rules.length, '顶层规则数异常（CSS 结构被破坏？）').toBeGreaterThan(700)
    const seen = new Map<string, number>()
    for (const r of rules) {
      const key = `${r.sel}\u0000${r.body}`
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k.split('\u0000')[0])
    expect(dups, `存在完全重复规则：${dups.join(' | ')}`).toEqual([])
  })

  it('不存在被后置同选择器规则完全覆盖的非 important 死声明', () => {
    const rules = topLevelRules(css)
    const bySel = new Map<string, Rule[]>()
    for (const r of rules) {
      if (!bySel.has(r.sel)) bySel.set(r.sel, [])
      bySel.get(r.sel)!.push(r)
    }
    const dead: string[] = []
    for (const [sel, group] of bySel) {
      for (let gi = 0; gi < group.length - 1; gi += 1) {
        const laterProps = new Set(group.slice(gi + 1).flatMap((r) => r.props))
        for (const prop of group[gi].props) {
          if (laterProps.has(prop)) dead.push(`${sel} { ${prop} }`)
        }
      }
    }
    expect(dead, `存在被后置规则完全覆盖的死声明：\n${dead.join('\n')}`).toEqual([])
  })

  it('.level-canvas 死规则不再存在（v4 舞台几何由内联 style 决定）', () => {
    // v4 舞台（LevelStageV4）几何完全由内联 style 决定；若内联几何被移除，本测试先失败，
    // 提醒重新评估是否需要恢复 .level-canvas 规则。
    expect(css, '出现 .level-canvas 规则：请确认不是重新引入死样式').not.toMatch(/^\.level-canvas\s*\{/m)
    expect(levelStageV4).toContain('width: STAGE_W')
    expect(levelStageV4).toContain('height: STAGE_H')
    expect(levelStageV4).toContain('left: fit.left')
  })

  it('不存在 src/ 中完全未引用的静态类样式（死类名防回涨）', () => {
    const classTokens = new Set([...css.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]))
    expect(classTokens.size, 'CSS 类名数量异常（文件被破坏？）').toBeGreaterThan(400)
    const dead = [...classTokens]
      .filter((token) => !SRC_TEXT.includes(token))
      .filter((token) => !DYNAMIC_PREFIXES.some((prefix) => token.startsWith(prefix)))
      .sort()
    expect(dead, `存在 src/ 中完全未引用的死类样式（请删除或加入动态前缀白名单）：\n${dead.join('\n')}`).toEqual([])
  })

  it('花括号平衡（删除重复规则/死声明后结构完整）', () => {
    const open = (css.match(/\{/g) ?? []).length
    const close = (css.match(/\}/g) ?? []).length
    expect(close).toBe(open)
  })
})
