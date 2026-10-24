/**
 * R17a（docs/44）G2 语义 token 层静态回归：
 * - `.graph-editor`（浅色）与 `.graph-editor.ge-dark`（深色）必须成对定义全部 --ui-* 语义 token；
 * - 深色映射必须是 `--ui-X: var(--ge-X)`（组件不再直接依赖千星色板 --ge-*）；
 * - 主题区规则中的颜色值必须来自 --ui-* / --ge-* 色板或允许的覆盖色（白/黑遮罩、画布小地图自定义色），
 *   不允许新增裸 hex/rgba（防止绕过语义层）；
 * - 千星色板定义只允许出现在 `.graph-editor.ge-dark` 调色板块内。
 * 说明：本测试只锁定「token 机制」，不代表像素级视觉正确性——视觉矩阵仍需浏览器人工复核（docs/44）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/** 语义 token 名单（浅/深映射必须完整成对） */
const UI_TOKENS = [
  'bg0', 'bg1', 'panel', 'panel-2', 'line', 'line-soft',
  'ink', 'ink-soft', 'ink-faint', 'muted', 'placeholder',
  'accent', 'accent-ink', 'cap', 'cap-ink', 'gold', 'warn', 'ok', 'bad', 'bad-ink', 'related',
  'node-bg', 'node-line', 'node-link', 'handle-bg', 'handle-line', 'edge',
  'input-bg', 'minimap-bg', 'controls-bg', 'controls-bg-hover', 'shadow-rgb',
]

/** 主题区范围：从节点图主题注释到调试布局章节（之前） */
function themeSection(): { text: string; start: number; end: number } {
  const start = css.indexOf('节点图 · 千星深色工作台主题')
  const end = css.indexOf('调试布局与画面')
  expect(start, '缺少节点图主题章节').toBeGreaterThanOrEqual(0)
  expect(end, '缺少调试布局章节').toBeGreaterThan(start)
  return { text: css.slice(start, end), start, end }
}

/** 从块起点（含 `{` 的行）配对右花括号，返回块体（不含最外层花括号） */
function blockBody(source: string, start: number): { body: string; start: number; end: number } {
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { body: source.slice(open + 1, i), start, end: i + 1 }
    }
  }
  throw new Error(`CSS 块未闭合：${source.slice(start, start + 60)}`)
}

function decl(blockBodyText: string, name: string): string | null {
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(blockBodyText)
  return m ? m[1].trim() : null
}

describe('G2 语义 token 层（R17a）', () => {
  const { text: section } = themeSection()
  // 浅色 token 块：主题区内含 --ui-panel 的 .graph-editor 块
  const lightStart = (() => {
    let from = 0
    for (;;) {
      const i = section.indexOf('.graph-editor {', from)
      if (i < 0) return -1
      const b = blockBody(section, i)
      if (decl(b.body, 'ui-panel') !== null) return i
      from = i + 1
    }
  })()
  const light = lightStart >= 0 ? blockBody(section, lightStart) : null
  const darkStart = section.indexOf('.graph-editor.ge-dark {')
  const dark = darkStart >= 0 ? blockBody(section, darkStart) : null

  it('浅色与深色成对定义全部语义 token；深色映射到 --ge-* 色板', () => {
    expect(light, '缺少 .graph-editor 浅色 token 块').toBeTruthy()
    expect(dark, '缺少 .graph-editor.ge-dark 色板块').toBeTruthy()
    for (const token of UI_TOKENS) {
      expect(decl(light!.body, `ui-${token}`), `浅色缺少 --ui-${token}`).not.toBeNull()
      expect(decl(dark!.body, `ui-${token}`), `深色缺少 --ui-${token}`).toBe(`var(--ge-${token})`)
      expect(decl(dark!.body, `ge-${token}`), `色板缺少 --ge-${token}`).not.toBeNull()
    }
  })

  it('主题区所有 --ui-* 引用都有定义（无拼写漂移）', () => {
    const known = new Set(UI_TOKENS)
    const refs = [...section.matchAll(/var\(--ui-([a-z0-9-]+)\)/g)].map((m) => m[1])
    expect(refs.length).toBeGreaterThan(100)
    const unknown = [...new Set(refs.filter((r) => !known.has(r)))]
    expect(unknown).toEqual([])
  })

  it('主题区组件规则不直接消费 --ge-*（仅深色映射行可引用色板）', () => {
    const offenders: string[] = []
    for (const line of section.split('\n')) {
      if (!line.includes('var(--ge-')) continue
      if (/^\s*--ui-[a-z0-9-]+:\s*var\(--ge-[a-z0-9-]+\);/.test(line)) continue // 深色映射行
      offenders.push(line.trim())
    }
    expect(offenders).toEqual([])
  })

  it('主题区规则无新增裸色值（调色板/允许遮罩除外）', () => {
    // 允许：色板定义行、由语义 token 派生的阴影、白/黑遮罩、画布小地图的既有自定义叠色
    const ALLOW = [
      /^\s*--ge-[a-z0-9-]+:/,
      /var\(--ui-shadow-rgb\)/,
      /rgb\(255 255 255 \//,
      /rgba\(255, 255, 255/,
      /rgba\(0, 0, 0/,
      /rgba\(56, 72, 110/,
    ]
    const colorRe = /#[0-9a-fA-F]{3,8}\b|rgba?\(/
    const offenders: string[] = []
    // 跳过色板块本身（色板定义允许 hex）
    const paletteRange = darkStart >= 0 && dark ? [darkStart, dark.end] : null
    let offset = 0
    for (const line of section.split('\n')) {
      const lineStart = offset
      offset += line.length + 1
      if (!colorRe.test(line)) continue
      if (paletteRange && lineStart >= paletteRange[0] && lineStart < paletteRange[1]) continue
      if (ALLOW.some((re) => re.test(line))) continue
      offenders.push(line.trim())
    }
    expect(offenders).toEqual([])
  })

  it('R17b：颜色收敛第一批已提升为 .graph-editor 共享规则；.ge-dark 规则数设预算防回涨', () => {
    // 第一批从 `.ge-dark X { color }` 提升为 `.graph-editor X { color: var(--ui-*) }`（浅色取值与原基础样式等价）
    const hoisted = [
      '.gnode-line',
      '.graph-lint-count',
      '.graph-canvas .gport-label',
      '.ai-mode-tab',
      '.gdock-close:hover',
      '.glib-title',
      '.graph-issue',
      '.graph-log-entry',
      '.graph-log-kind.command',
      '.graph-log-node',
      '.graph-issue-code',
      '.canvas-map-box span',
      '.gdock-title',
      '.ai-panel-head b',
      '.ai-msg',
      '.ai-msg-assistant',
      '.ai-tool-calls',
    ]
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    for (const sel of hoisted) {
      expect(
        new RegExp(`\\.ge-dark\\s+${esc(sel)}(?=\\s*[{,])`).test(section),
        `仍存在 .ge-dark 单色覆盖：${sel}`,
      ).toBe(false)
      expect(
        new RegExp(`\\.graph-editor\\s+${esc(sel)}(?=\\s*[{,])`).test(section),
        `缺少共享 token 规则：${sel}`,
      ).toBe(true)
    }
    // 预算：当前 143 行为基线（R17a 时约 158 行）；只允许不增，后续批次可下调
    const darkSelectorLines = css.split('\n').filter((l) => /^\s*\.ge-dark/.test(l)).length
    expect(darkSelectorLines).toBeLessThanOrEqual(143)
  })
})
