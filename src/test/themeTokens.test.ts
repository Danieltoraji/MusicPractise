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
  'map-box-bg',
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
    // 允许：色板定义行、由语义 token 派生的阴影、白/黑遮罩（视觉原语）。
    // G8（R25）后画布缩略图叠色已收编 --ui-map-box-bg，不再允许 rgba(56,72,110)。
    const ALLOW = [
      /^\s*--ge-[a-z0-9-]+:/,
      /var\(--ui-shadow-rgb\)/,
      /rgb\(255 255 255 \//,
      /rgba\(255, 255, 255/,
      /rgba\(0, 0, 0/,
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

  // ---------------------------------------------------------------------------
  // R22（docs/44）：G4 派生 token 作用域重算 + G5 内容岛 token/字体钉死
  // ---------------------------------------------------------------------------
  it('G4：ge-dark 作用域重算 focus-ring/shadow-*（派生 token 不再取 :root 一次性值）', () => {
    expect(dark, '缺少 .graph-editor.ge-dark 块').toBeTruthy()
    expect(decl(dark!.body, 'focus-ring'), 'ge-dark 未重算 --focus-ring').toContain('var(--ui-accent)')
    for (const shadow of ['shadow-1', 'shadow-2', 'shadow-3']) {
      expect(decl(dark!.body, shadow), `ge-dark 未重算 --${shadow}`).toContain('var(--ui-shadow-rgb)')
    }
  })

  it('G5：内容岛钉全套内容 token + 派生 token + 字体栈（文本度量/阴影不随皮肤漂移）', () => {
    const marker = css.indexOf('内容层浅色岛')
    expect(marker, '缺少内容层浅色岛注释').toBeGreaterThanOrEqual(0)
    const islandStart = css.indexOf('.stage-canvas,', marker)
    expect(islandStart, '缺少 .stage-canvas/.editor-canvas 钉值块').toBeGreaterThanOrEqual(0)
    const island = blockBody(css, islandStart)
    const CORE = [
      'panel', 'panel-2', 'soft', 'line', 'ink', 'muted',
      'accent', 'accent-ink', 'accent-soft', 'accent-soft-strong', 'accent-soft-2',
      'ok', 'ok-soft', 'ok-soft-strong', 'bad', 'bad-soft', 'bad-soft-strong',
      'warn', 'warn-soft', 'warn-soft-strong', 'warn-ink', 'warn-ink-2',
      'paper', 'shadow-rgb',
    ]
    const ST = [
      'st-key-white', 'st-key-white-soft', 'st-key-white-hover',
      'st-key-black', 'st-key-black-line', 'st-key-black-hover', 'st-keybed',
      'st-device-synth-bg', 'st-device-synth-ink', 'st-device-synth-muted',
      'st-device-sound-bg', 'st-device-sound-ink', 'st-device-sound-muted',
    ]
    const FONT = ['font-ui', 'font-display', 'font-mono', 'user-font-ui', 'user-font-display']
    const DERIVED = ['focus-ring', 'shadow-1', 'shadow-2', 'shadow-3']
    for (const token of [...CORE, ...ST, ...FONT, ...DERIVED]) {
      expect(decl(island.body, token), `内容岛缺少 --${token}`).not.toBeNull()
    }
    // 字体：岛内直接落 font-family（只钉 token 不足以覆盖 body 上已计算/继承的字体）
    expect(island.body).toContain('font-family: var(--font-ui)')
    expect(decl(island.body, 'user-font-ui')).toBe('var(--font-ui)') // 屏蔽用户字体覆盖（内容层稳定性）
    // 派生 token 用岛内变量重算
    expect(decl(island.body, 'focus-ring')).toContain('var(--accent)')
    for (const shadow of ['shadow-1', 'shadow-2', 'shadow-3']) {
      expect(decl(island.body, shadow), `内容岛未重算 --${shadow}`).toContain('var(--shadow-rgb)')
    }
  })

  // ---------------------------------------------------------------------------
  // R23（docs/44）：G13 --ge-* 引用白名单（深色映射 + gdb 双写 fallback）
  // ---------------------------------------------------------------------------
  it('G13：--ge-* 变量只允许「深色映射」与「gdb 双写 fallback」两类引用', () => {
    const mapping = [...css.matchAll(/--ui-[a-z0-9-]+:\s*var\(--ge-[a-z0-9-]+\);/g)]
    const fallback = [...css.matchAll(/var\(--ge-[a-z0-9-]+, var\(--[a-z0-9-]+\)\)/g)]
    const refs = [...css.matchAll(/var\(--ge-[a-z0-9-]+/g)]
    // 32 个语义 token 的深色映射（UI_TOKENS.length）
    expect(mapping.length, '深色映射行数漂移（新增 --ui-* 时同步 UI_TOKENS）').toBe(UI_TOKENS.length)
    // gdb-stage 的明暗双主题取值机制：5 处（改数量需同步 docs/40 G13 与 AGENTS）
    expect(fallback.length, 'gdb 双写 fallback 数量漂移').toBe(5)
    // 其它任何 var(--ge-*) 直用都会破坏「浅色回落」契约
    expect(refs.length, '出现未登记的 var(--ge-*) 直用（应改用 --ui-* 或双写 fallback）').toBe(
      mapping.length + fallback.length,
    )
  })

  // ---------------------------------------------------------------------------
  // R24（docs/44）：G10 z-index 层级令牌（裸数值守卫）
  // ---------------------------------------------------------------------------
  it('G10：z-index 全部走 --z-* 语义令牌；引用必须有定义', () => {
    const decls = [...css.matchAll(/z-index:\s*([^;]+);/g)].map((m) => m[1].trim())
    expect(decls.length, 'z-index 声明数量变化：新增/删除浮层需同步本守卫与 docs/44').toBe(15)
    for (const value of decls) {
      expect(value, `裸 z-index 数值未走令牌：${value}`).toMatch(/^var\(--z-[a-z0-9-]+\)$/)
    }
    const defined = new Set([...css.matchAll(/--z-[a-z0-9-]+:/g)].map((m) => m[0].slice(0, -1)))
    expect(defined.size, '--z-* 令牌表漂移').toBeGreaterThanOrEqual(10)
    for (const value of decls) {
      const name = value.match(/--z-[a-z0-9-]+/)![0]
      expect(defined.has(name), `z-index 引用了未定义令牌 ${name}`).toBe(true)
    }
  })
})
