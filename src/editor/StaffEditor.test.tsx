// 五线谱编辑器纯函数：diatonic↔midi 换算 / 时序游标 / 附点 / 音名输入与音高步进（docs/27 + MuseScore 风格输入）
import { describe, expect, it } from 'vitest'
import { cursorBeat, dnToMidi, midiToDn, nearestWhiteBelow, startBeats, stepDiatonic, whiteMidiFromLetter, withDot } from './StaffEditor'

describe('diatonic 换算', () => {
  it('dnToMidi：C4=28→60、F5=38→77（高音谱顶线）、C6=42→84', () => {
    expect(dnToMidi(28)).toBe(60)
    expect(dnToMidi(38)).toBe(77)
    expect(dnToMidi(42)).toBe(84)
  })

  it('midiToDn：白键往返一致；黑键返回 -1', () => {
    for (let dn = 14; dn < 50; dn++) expect(midiToDn(dnToMidi(dn))).toBe(dn)
    expect(midiToDn(61)).toBe(-1) // C♯
    expect(midiToDn(66)).toBe(-1) // F♯
  })

  it('nearestWhiteBelow：黑键向下归属白键', () => {
    expect(nearestWhiteBelow(61)).toBe(60)
    expect(nearestWhiteBelow(66)).toBe(65)
    expect(nearestWhiteBelow(60)).toBe(60)
  })
})

describe('时序游标（与运行时 scheduleNoteEvents 同一语义）', () => {
  it('无 t 接排：游标逐音累加 dur', () => {
    expect(startBeats([{ midi: 60, dur: '4n' }, { midi: 64, dur: '8n' }])).toEqual([0, 1])
    expect(cursorBeat([{ midi: 60, dur: '4n' }, { midi: 64, dur: '8n' }])).toBe(1.5)
  })

  it('相同 t 同时响；t 跳跃推进游标', () => {
    expect(startBeats([{ midi: 60, dur: '4n', t: 0 }, { midi: 64, dur: '4n', t: 0 }, { midi: 67, dur: '4n', t: 2 }])).toEqual([0, 0, 2])
    expect(cursorBeat([{ midi: 60, dur: '4n', t: 0 }, { midi: 64, dur: '4n', t: 0 }, { midi: 67, dur: '4n', t: 2 }])).toBe(3)
  })

  it('休止符占位推进游标', () => {
    expect(startBeats([{ midi: 60, dur: '4n' }, { rest: true, dur: '2n' }, { midi: 67, dur: '4n' }])).toEqual([0, 1, 3])
    expect(cursorBeat([{ midi: 60, dur: '4n' }, { rest: true, dur: '2n' }, { midi: 67, dur: '4n' }])).toBe(4)
  })
})

describe('withDot（附点时值）', () => {
  it('加附点 / 已有附点不重复 / 去附点', () => {
    expect(withDot('4n', true)).toBe('4n.')
    expect(withDot('4n.', true)).toBe('4n.')
    expect(withDot('4n', false)).toBe('4n')
  })
})

describe('MuseScore 风格输入（音名键与音高步进）', () => {
  it('whiteMidiFromLetter：取与参考音最近的同名白键（跨 B→C 自然换八度）', () => {
    expect(whiteMidiFromLetter('c', 64)).toBe(60) // E4 参考 → C4
    expect(whiteMidiFromLetter('c', 69)).toBe(72) // A4 参考 → C5（更近）
    expect(whiteMidiFromLetter('b', 60)).toBe(59) // C4 参考 → B3
    expect(whiteMidiFromLetter('f', 64)).toBe(65)
  })

  it('stepDiatonic：白键走音级；黑键 ↑ 进上白键、↓ 退本位白键', () => {
    expect(stepDiatonic(60, 1)).toBe(62) // C4 → D4
    expect(stepDiatonic(60, -1)).toBe(59) // C4 → B3
    expect(stepDiatonic(61, 1)).toBe(62) // C♯4 ↑ → D4
    expect(stepDiatonic(61, -1)).toBe(60) // C♯4 ↓ → C4（本位）
    expect(stepDiatonic(66, 1)).toBe(67) // F♯4 ↑ → G4
  })
})
