import { describe, expect, it } from 'vitest'
import { rhythmMatch } from './rhythm'

describe('rhythmMatch', () => {
  it('全命中', () => {
    const grid = [0, 0.5, 1.0, 1.5]
    const taps = [0.01, 0.49, 1.02, 1.48]
    const r = rhythmMatch(taps, grid, 120)
    expect(r.score).toBe(1)
    expect(r.extraTaps).toHaveLength(0)
  })

  it('漏拍与多拍', () => {
    const grid = [0, 0.5, 1.0, 1.5]
    const taps = [0.02, 1.51, 1.7]
    const r = rhythmMatch(taps, grid, 100)
    expect(r.score).toBe(0.5)
    expect(r.hits[1]).toBe(null)
    expect(r.extraTaps).toEqual([1.7])
  })

  it('容差边界', () => {
    expect(rhythmMatch([0.12], [0], 120).score).toBe(1)
    expect(rhythmMatch([0.13], [0], 120).score).toBe(0)
  })

  it('同一 tap 不会消费两个槽位', () => {
    const r = rhythmMatch([0.5], [0.4, 0.55], 200)
    expect(r.score).toBe(0.5)
    expect(r.hits[1]).not.toBe(null)
  })

  it('延迟偏移整体一致时全中（校准场景）', () => {
    const grid = [0, 0.5, 1, 1.5]
    const taps = grid.map((g) => g + 0.08) // 人手延迟 80ms
    expect(rhythmMatch(taps, grid, 120).score).toBe(1)
    expect(rhythmMatch(taps, grid, 60).score).toBe(0)
  })
})
