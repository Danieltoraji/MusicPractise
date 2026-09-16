// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { toStaveNotes } from './views'

describe('toStaveNotes（P1 bass 音位回归）', () => {
  it('同一音符在 bass/treble 谱号下落在不同线；不传 clef 的回归已由组件内默认 treble 兜住', () => {
    const bass = toStaveNotes({ notes: [{ midi: 43 }], clef: 'bass' }) // G2
    const treble = toStaveNotes({ notes: [{ midi: 43 }], clef: 'treble' })
    // 修复前：StaveNote 未传 clef，一律按 treble 定位 → bass 谱面全部音位错位约 6 行
    expect(bass[0].getLineNumber()).toBe(1) // G2 在低音谱第四线（0 起，含下加线计）
    expect(treble[0].getLineNumber()).toBe(-5)
    expect(bass[0].getLineNumber()).not.toBe(treble[0].getLineNumber())
  })

  it('缺省 clef 为 treble', () => {
    const notes = toStaveNotes({ notes: [{ midi: 64 }] })
    expect(notes[0].getLineNumber()).toBe(toStaveNotes({ notes: [{ midi: 64 }], clef: 'treble' })[0].getLineNumber())
  })

  it('附点时值生成 Dot 修饰（不抛错且时值保持基础形态）', () => {
    expect(() => toStaveNotes({ notes: [{ midi: 60, dur: '2n.' }] })).not.toThrow()
    const plain = toStaveNotes({ notes: [{ midi: 60, dur: '2n' }] })
    const dotted = toStaveNotes({ notes: [{ midi: 60, dur: '2n.' }] })
    expect(dotted).toHaveLength(1)
    expect(plain).toHaveLength(1)
  })

  it('升降号音符可构建', () => {
    expect(() => toStaveNotes({ notes: [{ midi: 61 }, { midi: 66 }, { midi: 70 }] })).not.toThrow()
  })
})
