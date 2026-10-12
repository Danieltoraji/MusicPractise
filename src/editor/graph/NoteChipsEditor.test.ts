import { describe, expect, it } from 'vitest'
import { notesFromCell, notesToCell, parseNoteTokens } from './NoteChipsEditor'

describe('notesFromCell / notesToCell（数据表 notes 列读写）', () => {
  it('合法对象数组往返；未知键拒绝', () => {
    const cell = [{ midi: 60, dur: '4n' }, { rest: true, dur: '8n', t: 1.5 }]
    const notes = notesFromCell(cell)
    expect(notes).not.toBeNull()
    expect(notesToCell(notes!)).toEqual(cell)
    expect(notesFromCell([{ midi: 60, dur: '4n', ghost: 1 }])).toBeNull()
    expect(notesFromCell('C4:4n')).toBeNull()
    expect(notesFromCell(null)).toEqual([])
  })
})

describe('parseNoteTokens（五线谱弹窗从文本导入）', () => {
  it('音名/MIDI 号/休止符 + 缺省与显式时值', () => {
    expect(parseNoteTokens('C4')).toEqual([{ midi: 60, dur: '4n' }])
    expect(parseNoteTokens('C4 E4 G4:2n')).toEqual([
      { midi: 60, dur: '4n' },
      { midi: 64, dur: '4n' },
      { midi: 67, dur: '2n' },
    ])
    expect(parseNoteTokens('60, 62:8n.、r R 0')).toEqual([
      { midi: 60, dur: '4n' },
      { midi: 62, dur: '8n.' },
      { rest: true, dur: '4n' },
      { rest: true, dur: '4n' },
      { rest: true, dur: '4n' },
    ])
    expect(parseNoteTokens('Db3:16n 127')).toEqual([
      { midi: 49, dur: '16n' },
      { midi: 127, dur: '4n' },
    ])
  })

  it('空文本 → 空数组；非法 token 整体拒绝返回 null', () => {
    expect(parseNoteTokens('   ')).toEqual([])
    expect(parseNoteTokens('C4 H5')).toBeNull()
    expect(parseNoteTokens('C4:3n')).toBeNull()
    expect(parseNoteTokens('C4:4n.')).toEqual([{ midi: 60, dur: '4n.' }])
    expect(parseNoteTokens('128')).toBeNull()
    expect(parseNoteTokens('C#:x')).toBeNull()
  })
})
