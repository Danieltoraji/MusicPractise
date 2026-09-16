/**
 * 节奏判定纯函数。时间单位统一为秒（AudioContext.currentTime 域），
 * tolerance 为毫秒（对创作者更直观）。
 */

export interface RhythmResult {
  /** 命中数 / 网格数，0..1 */
  score: number
  /** 每个网格槽位命中的 tap 下标；null=未命中 */
  hits: (number | null)[]
  /** 未被任何槽位消费的 tap（多打的） */
  extraTaps: number[]
  /** 每个命中槽位的偏差（秒，tap - grid） */
  deltas: (number | null)[]
}

export function rhythmMatch(taps: number[], grid: number[], toleranceMs: number): RhythmResult {
  const tol = toleranceMs / 1000
  const tolSlots = new Set<number>()
  const usedTaps = new Set<number>()
  const hitOfSlot = new Map<number, { tap: number; delta: number }>()

  // 全部 (槽位, tap) 候选对按距离升序做全局贪心：每个 tap 归给离它最近的槽位
  const pairs: { slot: number; tap: number; dist: number }[] = []
  grid.forEach((slot, si) => {
    taps.forEach((t, ti) => {
      const dist = Math.abs(t - slot)
      if (dist <= tol) pairs.push({ slot: si, tap: ti, dist })
    })
  })
  pairs.sort((a, b) => a.dist - b.dist)
  for (const p of pairs) {
    if (tolSlots.has(p.slot) || usedTaps.has(p.tap)) continue
    tolSlots.add(p.slot)
    usedTaps.add(p.tap)
    hitOfSlot.set(p.slot, { tap: p.tap, delta: taps[p.tap] - grid[p.slot] })
  }

  const hits: (number | null)[] = []
  const deltas: (number | null)[] = []
  for (let si = 0; si < grid.length; si++) {
    const h = hitOfSlot.get(si)
    hits.push(h ? h.tap : null)
    deltas.push(h ? h.delta : null)
  }

  const extraTaps = taps.filter((_, ti) => !usedTaps.has(ti))
  const hitCount = hitOfSlot.size
  return { score: grid.length === 0 ? 0 : hitCount / grid.length, hits, extraTaps, deltas }
}
