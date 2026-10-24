#!/usr/bin/env node
/**
 * R35（docs/44）：G15 同名选择器冲突分类（docs/45 EXT-2 的静态前置）。
 *
 * 只读，不修改 CSS。把顶层规则按选择器分组后做**逐条对后置规则并集**的分类：
 *  - identical-duplicate：组内存在同选择器+同声明（应由 g15Css 守卫挡下，正常为 0）
 *  - fully-shadowed：前面规则的声明被后置规则并集完全覆盖（应由 g15Css 守卫挡下，正常为 0）
 *  - value-conflict：前面规则的同名属性在后置规则中取了不同值——**需视觉矩阵逐组决策**
 *  - token-layering：后置规则只声明 CSS 自定义属性（--x）——令牌分层，预期保留
 *  - skin-override：选择器含 .ge-dark/[data-skin]——主题皮肤覆盖，预期保留
 *  - additive：前后规则无同名属性——叠加使用，无冲突
 *
 * 用法：node scripts/css-conflicts.mjs [--json]
 */
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')

function parseTopLevel(source) {
  const rules = []
  let i = 0
  while (i < source.length) {
    const open = source.indexOf('{', i)
    if (open < 0) break
    let depth = 0
    let end = open
    for (; end < source.length; end += 1) {
      if (source[end] === '{') depth += 1
      else if (source[end] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const rawSelector = source.slice(i, open)
    if (!rawSelector.includes('@')) {
      const sel = rawSelector.replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/\s+/g, ' ')
      const body = source.slice(open + 1, end)
      const decls = []
      for (const part of body.split(';')) {
        const text = part.replace(/\/\*[\s\S]*?\*\//g, '').trim()
        if (!text) continue
        const colon = text.indexOf(':')
        if (colon <= 0) continue
        decls.push({ prop: text.slice(0, colon).trim(), value: text.slice(colon + 1).trim() })
      }
      if (sel && decls.length > 0) rules.push({ sel, decls, body: body.replace(/\s+/g, ' ').trim() })
    }
    i = end + 1
  }
  return rules
}

const rules = parseTopLevel(css)
const groups = new Map()
for (const rule of rules) {
  if (!groups.has(rule.sel)) groups.set(rule.sel, [])
  groups.get(rule.sel).push(rule)
}

const isCustomProp = (prop) => prop.startsWith('--')
const categories = {
  'identical-duplicate': [],
  'fully-shadowed': [],
  'value-conflict': [],
  'token-layering': [],
  'skin-override': [],
  additive: [],
}
let multiRuleGroups = 0

for (const [selector, list] of groups) {
  if (list.length < 2) continue
  multiRuleGroups += 1
  const bodies = list.map((r) => r.body)
  if (new Set(bodies).size < bodies.length) {
    categories['identical-duplicate'].push({ selector, detail: '组内存在完全相同的规则' })
    continue
  }
  if (selector.includes('.ge-dark') || selector.includes('[data-skin')) {
    categories['skin-override'].push({ selector, detail: '主题/皮肤覆盖' })
    continue
  }
  for (let i = 0; i < list.length - 1; i += 1) {
    const earlier = list[i]
    const laterRules = list.slice(i + 1)
    const laterValues = new Map()
    for (const rule of laterRules) {
      for (const decl of rule.decls) {
        if (!laterValues.has(decl.prop)) laterValues.set(decl.prop, new Set())
        laterValues.get(decl.prop).add(decl.value)
      }
    }
    const valueConflicts = []
    let covered = 0
    for (const decl of earlier.decls) {
      const values = laterValues.get(decl.prop)
      if (!values) continue
      covered += 1
      if ([...values].some((value) => value !== decl.value)) {
        valueConflicts.push(`${decl.prop}: ${decl.value} → ${[...values].join(' / ')}`)
      }
    }
    if (valueConflicts.length > 0) {
      categories['value-conflict'].push({ selector, detail: valueConflicts.join('; ') })
    } else if (covered === earlier.decls.length) {
      categories['fully-shadowed'].push({ selector, detail: '整条声明被后置规则覆盖' })
    } else if (laterRules.every((rule) => rule.decls.every((decl) => isCustomProp(decl.prop)))) {
      categories['token-layering'].push({ selector, detail: '仅自定义属性覆盖' })
    } else {
      categories.additive.push({ selector, detail: '无同名属性，叠加规则' })
    }
  }
}

const json = process.argv.includes('--json')
if (json) {
  console.log(JSON.stringify({ multiRuleGroups, categories }, null, 2))
} else {
  console.log('# G15 同名选择器冲突分类（只读报告）\n')
  console.log(`同名选择器组（≥2 条顶层规则）：**${multiRuleGroups}** 组\n`)
  for (const [name, items] of Object.entries(categories)) {
    console.log(`## ${name}（${items.length}）\n`)
    for (const item of items) console.log(`- \`${item.selector}\` — ${item.detail}`)
    if (items.length === 0) console.log('- （无）')
    console.log()
  }
  console.log('结论：value-conflict / identical-duplicate / fully-shadowed 才是需要处理的工作清单；')
  console.log('token-layering / skin-override / additive 属于预期分层，不应批量删除。')
}
