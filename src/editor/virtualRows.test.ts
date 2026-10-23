/**
 * D1 行虚拟化几何函数单测（docs/43 §7 → R14）：
 * 覆盖率 = 可视区间计算的全部边界：空表、固定/可变行高、精确行边界、超滚动、overscan、负值兜底。
 */
import { describe, expect, it } from 'vitest'
import { buildRowMetrics, visibleRowRange } from './virtualRows'

const fixed = (n: number, h: number) => buildRowMetrics(n, () => h)

describe('buildRowMetrics', () => {
  it('固定行高：偏移表与总高度准确，最后一项 = 总高度', () => {
    const m = fixed(4, 36)
    expect(m.offsets).toEqual([0, 36, 72, 108, 144])
    expect(m.totalHeight).toBe(144)
  })

  it('可变行高与非法行高兜底（0/NaN/负数按 1px，保证偏移单调）', () => {
    const m = buildRowMetrics(4, (i) => [40, 0, Number.NaN, -5][i] as number)
    expect(m.offsets).toEqual([0, 40, 41, 42, 43])
    expect(m.totalHeight).toBe(43)
  })

  it('空表：只有 0 偏移，总高度 0', () => {
    const m = buildRowMetrics(0, () => 36)
    expect(m.offsets).toEqual([0])
    expect(m.totalHeight).toBe(0)
  })
})

describe('visibleRowRange', () => {
  it('空表返回 [0,0)', () => {
    expect(visibleRowRange(fixed(0, 36), 0, 600, 4)).toEqual({ start: 0, end: 0 })
  })

  it('滚动在顶部：从第 0 行开始，渲染高度覆盖 viewport + overscan', () => {
    const { start, end } = visibleRowRange(fixed(100, 36), 0, 300, 4)
    expect(start).toBe(0)
    // 300px / 36px ≈ 9 行，+4 overscan
    expect(end).toBeLessThanOrEqual(13)
    expect(end).toBeGreaterThanOrEqual(9)
  })

  it('精确落在行边界：不包含下一行（避免多挂一行）', () => {
    const m = fixed(10, 100) // 行 i 占 [100i, 100i+100)
    // scrollTop=100, viewport=100 → 只应覆盖第 1 行（索引 1），不含第 2 行
    const { start, end } = visibleRowRange(m, 100, 100, 0)
    expect(start).toBe(1)
    expect(end).toBe(2)
  })

  it('滚动到中部：命中正确行并保留 overscan', () => {
    const m = fixed(100, 36)
    const { start, end } = visibleRowRange(m, 36 * 50, 360, 2)
    expect(start).toBe(48) // 首可视行 50，overscan 2
    expect(end).toBe(62) // 覆盖到索引 60 的行（50..59 → end=60）+2
    expect(end).toBeGreaterThan(50)
  })

  it('滚动超表尾/负数：夹紧到合法范围而不越界', () => {
    const m = fixed(10, 36)
    const top = visibleRowRange(m, 0, 600, 0)
    expect(top).toEqual({ start: 0, end: 10 })
    const over = visibleRowRange(m, 99999, 600, 4)
    expect(over.start).toBeGreaterThanOrEqual(0)
    expect(over.end).toBe(10)
    const negative = visibleRowRange(m, -500, 100, 0)
    expect(negative.start).toBe(0)
  })

  it('viewport 非法（0/NaN）：按 1px 兜底，至少渲染一行', () => {
    const m = fixed(10, 36)
    expect(visibleRowRange(m, 0, 0, 0)).toEqual({ start: 0, end: 1 })
    expect(visibleRowRange(m, 0, Number.NaN as number, 0)).toEqual({ start: 0, end: 1 })
  })

  it('512 行满配（docs/40 schema 上限）在 600px 视口只挂载 ≤ 25 行', () => {
    const m = fixed(512, 36)
    const { start, end } = visibleRowRange(m, 0, 600, 4)
    expect(end - start).toBeLessThanOrEqual(25)
    const mid = visibleRowRange(m, 36 * 400, 600, 4)
    expect(mid.end - mid.start).toBeLessThanOrEqual(25)
  })
})
