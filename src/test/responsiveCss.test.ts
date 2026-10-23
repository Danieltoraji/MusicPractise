/**
 * G1 节点图窄屏断点回归（docs/42 §5.1-G1）：
 * 媒体查询必须存在且位于 index.css 文件尾——同特异性「后者胜」，若写在正文
 * .graph-layout/.graph-canvas 覆盖块之前，会被文件尾无条件规则反覆盖（G7 教训）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

/** 从块起点（@media 或普通规则）找到配对右花括号之后 */
function blockRange(source: string, start: number): { body: string; end: number } {
  let depth = 0
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { body: source.slice(start, i + 1), end: i + 1 }
    }
  }
  throw new Error(`index.css 存在未闭合块：${source.slice(start, start + 40)}…`)
}

function lastIndexOrThrow(marker: string): number {
  const i = css.lastIndexOf(marker)
  expect(i, `index.css 缺少 ${marker}`).toBeGreaterThanOrEqual(0)
  return i
}

describe('G1 节点图窄屏断点（index.css 文件尾）', () => {
  it('≤1280：工作台横向滚动 + 画布保底宽度', () => {
    const { body } = blockRange(css, lastIndexOrThrow('@media (max-width: 1280px)'))
    expect(body).toMatch(/\.graph-layout\s*\{[^}]*overflow-x:\s*auto/)
    expect(body).toMatch(/\.graph-canvas\s*\{[^}]*min-width:\s*520px/)
  })

  it('守卫提示条：基础规则隐藏、≤1100 显示', () => {
    // 基础规则是文件里第一处（媒体查询内还有一处同名规则）
    const base = css.indexOf('.graph-narrow-tip {')
    expect(base).toBeGreaterThanOrEqual(0)
    const baseBlock = blockRange(css, base)
    expect(baseBlock.body).toMatch(/display:\s*none/)
    const { body } = blockRange(css, lastIndexOrThrow('@media (max-width: 1100px)'))
    expect(body).toMatch(/\.graph-narrow-tip\s*\{[^}]*display:\s*inline/)
  })

  it('媒体块位于文件尾（编辑器 ≤900 块之后，且 ≤1100 块之后只有空白）', () => {
    const last900 = lastIndexOrThrow('@media (max-width: 900px)')
    const graph1280 = lastIndexOrThrow('@media (max-width: 1280px)')
    const graph1100 = lastIndexOrThrow('@media (max-width: 1100px)')
    expect(graph1280).toBeGreaterThan(last900)
    expect(graph1100).toBeGreaterThan(graph1280)
    expect(css.slice(blockRange(css, graph1100).end).trim()).toBe('')
  })
})
