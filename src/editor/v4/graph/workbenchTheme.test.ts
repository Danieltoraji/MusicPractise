/**
 * v4 图工作台静态门禁（对齐 docs/44 G9/G15 口径，覆盖 W6 新增文件）：
 * - React Flow 的 Background/MiniMap 颜色必须走 `var(--ui-*)`（明暗由 .graph-editor/.ge-dark 作用域解析），
 *   不允许裸 hex（浅色主题会误用深色色值）；
 * - v4-graph.css 只消费 `--ui-*` / 全局设计令牌，不出现裸色值，也不直接使用 `--ge-*`（G13 契约：
 *   直用色板会破坏浅色 fallback）；
 * - 工作台不写内联颜色样式（类别色由 v4-graph.css 的 kind 色带负责）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workbench = readFileSync(new URL('./GraphWorkbench.tsx', import.meta.url), 'utf8')
const graphCard = readFileSync(new URL('./GraphCard.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../v4-graph.css', import.meta.url), 'utf8')

const HEX = /#[0-9a-fA-F]{3,8}\b/

describe('v4 图工作台 · 主题色静态门禁（G9/G13）', () => {
  it('Background 点阵 / MiniMap 颜色走 --ui-* token，无裸 hex', () => {
    expect(workbench).toMatch(/<Background[^>]*color="var\(--ui-[a-z0-9-]+\)"/)
    expect(workbench).toMatch(/<MiniMap[^>]*nodeColor="var\(--ui-[a-z0-9-]+\)"/)
    expect(workbench).toMatch(/<MiniMap[^>]*nodeStrokeColor="var\(--ui-[a-z0-9-]+\)"/)
    expect(workbench).not.toMatch(/<Background[^>]*color="#/)
    expect(workbench).not.toMatch(/<MiniMap[^>]*(nodeColor|nodeStrokeColor)="#/)
  })

  it('工作台/节点卡源码不含裸 hex 颜色（类别色走 CSS kind 色带）', () => {
    expect(workbench).not.toMatch(HEX)
    expect(graphCard).not.toMatch(HEX)
  })

  it('v4-graph.css 无裸色、无 --ge-* 直用（只消费 --ui-* 语义层）', () => {
    expect(css).not.toMatch(HEX)
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/)
    expect(css).not.toMatch(/var\(--ge-/)
    // 色带规则必须存在（kind → 类别色）
    expect(css).toMatch(/\.v4-gnode-band-start\s*\{[^}]*var\(--ui-/)
    expect(css).toMatch(/\.v4-gnode-band-branch[\s\S]*?var\(--ui-/)
  })
})
