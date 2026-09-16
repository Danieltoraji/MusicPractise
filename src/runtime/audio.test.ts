import { describe, expect, it } from 'vitest'
import { durToSeconds } from './audio'

describe('durToSeconds（时值记法 → 秒）', () => {
  it.each([
    ['4n', 90, 60 / 90],
    ['2n', 90, 120 / 90],
    ['1n', 90, 240 / 90],
    ['8n', 120, 30 / 120],
    ['16n', 120, 15 / 120],
    ['32n', 120, 7.5 / 120],
    ['2n.', 90, 180 / 90], // 附点 = 1.5 倍
    ['4n.', 60, 90 / 60],
  ] as const)('%s @ %s BPM → %ss', (dur, tempo, expected) => {
    expect(durToSeconds(dur, tempo)).toBeCloseTo(expected, 10)
  })

  it('未知时值回退为四分音符并告警', () => {
    expect(durToSeconds('3n', 90)).toBeCloseTo(60 / 90, 10)
  })

  it('缺省速度 90', () => {
    expect(durToSeconds('4n')).toBeCloseTo(2 / 3, 10)
  })
})
