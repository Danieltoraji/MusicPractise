/**
 * G11（docs/40 / docs/44 R26）：性能/无障碍静态契约。
 *
 * - 系统 `prefers-reduced-motion: reduce` 时关闭动画与过渡（节点图辉光/脉冲等）；
 * - 媒体查询必须放在文件尾（G7：同特异性后者胜，放前面会被后置规则覆盖）；
 * - LevelStage fit 的纯函数/短路单测在 LevelStage.test.tsx（computeStageFit）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')

describe('G11 减少动效偏好（docs/44 R26）', () => {
  it('存在 prefers-reduced-motion 降级块，且关闭动画/过渡', () => {
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(block).toContain('animation-duration: 0.01ms')
    expect(block).toContain('animation-iteration-count: 1')
    expect(block).toContain('transition-duration: 0.01ms')
    expect(block).toContain('scroll-behavior: auto')
  })

  it('减少动效块位于文件尾（晚于被覆盖的动画/过渡规则，G7 教训）', () => {
    const at = css.lastIndexOf('@media (prefers-reduced-motion: reduce)')
    const tail = css.slice(at)
    // 块之后不再有其它样式规则（允许空白/换行）
    expect(tail.replace(/\s+/g, ' ').trim()).toMatch(/^@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\}\s*$/)
    // 且在所有 max-width 媒体查询之后
    const lastWidth = css.lastIndexOf('@media (max-width:')
    expect(at).toBeGreaterThan(lastWidth)
  })
})
