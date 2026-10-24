/**
 * G7（docs/40 / docs/44 R27）：同特异性「后写覆盖」/ 死声明审计守卫。
 *
 * 四个历史问题（R27 审计结论）：
 * 1. `.tjson-modal.tlist-modal` 宽度覆盖——双类选择器（0,2,0）> 单类 `.tjson-modal`（0,1,0），
 *    不受声明顺序影响，有效（保留双类 + `.modal-shell.tlist-modal` alias）；
 * 2. `.json-tab` 缺 display:flex——当前主规则已含 flex 列布局；
 * 3. `.editor-canvas-layout` wrap→nowrap 后 `> p` 死规则——R27 已删除死声明；
 * 4. docs 页 720px 媒体查询必须晚于全部 `.docs-*` 基础规则。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/** 找选择器（按行首匹配）在 CSS 中的位置；找不到则 -1 */
function selectorAt(selector: string, from = 0): number {
  return css.indexOf(`\n${selector}`, from) + (css.startsWith(selector) ? 0 : 0)
}

describe('G7 同特异性覆盖 / 死声明（docs/44 R27）', () => {
  it('.tjson-modal.tlist-modal 双类宽度覆盖仍存在（特异性高于单类）', () => {
    expect(css).toContain('.tjson-modal.tlist-modal')
    expect(css).toContain('.modal-shell.tlist-modal')
    const ruleStart = css.indexOf('.tjson-modal.tlist-modal')
    const body = css.slice(ruleStart, ruleStart + 120)
    expect(body).toMatch(/width:\s*min\(520px, 92vw\)/)
  })

  it('.json-tab 主规则保留 flex 列布局（此前缺失导致 textarea 不撑满）', () => {
    const at = css.indexOf('\n.json-tab {')
    expect(at, '缺少 .json-tab 主规则').toBeGreaterThanOrEqual(0)
    const body = css.slice(at, at + 160)
    expect(body).toMatch(/display:\s*flex/)
    expect(body).toMatch(/flex-direction:\s*column/)
  })

  it('编辑器画布布局不再含已被 nowrap 覆盖的死声明/死选择器', () => {
    // 基础块不再写会被后置 nowrap/stretch 覆盖的 flex-wrap/align-items
    const baseAt = selectorAt('.editor-canvas-layout {')
    expect(baseAt, '缺少 .editor-canvas-layout 基础规则').toBeGreaterThanOrEqual(0)
    const baseBody = css.slice(baseAt, baseAt + 120).split('}')[0]
    expect(baseBody).not.toMatch(/flex-wrap/)
    expect(baseBody).not.toMatch(/align-items/)
    // `> p` 规则已无匹配元素（空态提示在 .editor-canvas 内）
    expect(css).not.toMatch(/^\.editor-canvas-layout > p\s*\{/m)
    // 后置三栏规则仍负责 nowrap/stretch
    const laterAt = css.lastIndexOf('\n.editor-canvas-layout {')
    expect(laterAt).toBeGreaterThan(baseAt)
    expect(css.slice(laterAt, laterAt + 120)).toMatch(/flex-wrap:\s*nowrap/)
  })

  it('docs 页窄屏媒体查询晚于相关基础规则（G7 媒体查询覆盖教训）', () => {
    const docsMedia = [...css.matchAll(/@media \(max-width: 720px\) \{/g)].find((m) =>
      css.slice(m.index, m.index + 800).includes('.docs {'),
    )
    expect(docsMedia, '缺少 docs 页 720 媒体查询').toBeTruthy()
    const mediaAt = docsMedia!.index!
    // 被媒体查询覆盖的 .docs/.docs-side 基础规则必须在媒体块之前
    for (const selector of ['\n.docs {', '\n.docs-side {']) {
      const baseAt = css.indexOf(selector)
      expect(baseAt, `缺少基础规则 ${selector.trim()}`).toBeGreaterThanOrEqual(0)
      expect(mediaAt, `媒体查询早于 ${selector.trim()} 基础规则`).toBeGreaterThan(baseAt)
    }
    const block = css.slice(mediaAt, mediaAt + 800)
    expect(block).toContain('.docs {')
    expect(block).toContain('grid-template-columns: 1fr')
  })
})
