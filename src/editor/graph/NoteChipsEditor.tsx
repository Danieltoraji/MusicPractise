/**
 * 音符序列 chips 编辑器（3-7 抽取共用）：sound/synth.play 参数编辑器与数据表 notes 列
 * 单元格共用同一套交互——音名下拉（C2–C7，tonal 换算）+ 时值下拉 + 频率 Hz 换算添加 + 删除。
 * 受控组件：notes 数组进出，不含表达式语义（那是 PlayArgsEditor 的职责）。
 */
import { useState } from 'react'
import { Note } from 'tonal'

export interface PlayNote {
  midi: number
  dur: string
}

export const DUR_OPTIONS = ['1n', '2n', '4n', '8n', '16n', '32n']

/** C2–C7 的音名候选（tonal 换算，标签带 MIDI 值方便对照） */
export const NOTE_OPTIONS: { value: number; label: string }[] = (() => {
  const out: { value: number; label: string }[] = []
  for (let midi = 24; midi <= 96; midi++) {
    out.push({ value: midi, label: `${Note.fromMidi(midi) ?? midi} (${midi})` })
  }
  return out
})()

export function NoteChipsEditor(props: {
  notes: PlayNote[]
  onChange: (notes: PlayNote[]) => void
}): React.ReactElement {
  const [freqText, setFreqText] = useState('')
  const { notes } = props

  const set = (notes: PlayNote[]): void => props.onChange(notes)
  const addNote = (midi: number, dur: string): void =>
    set([...notes, { midi: Math.max(0, Math.min(127, Math.round(midi))), dur }])

  const addByFreq = (): void => {
    const freq = Number(freqText)
    if (!Number.isFinite(freq) || freq <= 0) return
    const midi = Math.max(0, Math.min(127, Math.round(69 + 12 * Math.log2(freq / 440))))
    addNote(midi, '4n')
    setFreqText('')
  }

  return (
    <span className="play-notes">
      {notes.map((n, i) => (
        <span key={`${n.midi}-${n.dur}-${i}`} className="play-note">
          <select
            value={n.midi}
            title="音名"
            onChange={(e) => {
              set(notes.map((x, j) => (j === i ? { ...x, midi: Number(e.target.value) } : x)))
            }}
          >
            {NOTE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
            {!NOTE_OPTIONS.some((o) => o.value === n.midi) && <option value={n.midi}>{`${n.midi}`}</option>}
          </select>
          <select
            value={n.dur}
            title="时值"
            onChange={(e) => {
              set(notes.map((x, j) => (j === i ? { ...x, dur: e.target.value } : x)))
            }}
          >
            {DUR_OPTIONS.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <button
            type="button"
            className="play-note-del"
            title="删除该音符"
            onClick={() => set(notes.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </span>
      ))}
      <span className="play-note play-note-add">
        <select value="" onChange={(e) => { if (e.target.value) addNote(Number(e.target.value), '4n') }} title="按音名添加">
          <option value="">+ 音名…</option>
          {NOTE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </span>
      <span className="play-note play-note-freq">
        <input
          type="number"
          placeholder="频率 Hz"
          value={freqText}
          min={20}
          max={8000}
          onChange={(e) => setFreqText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addByFreq()
          }}
        />
        <button type="button" title="按频率添加（自动换算最近的音名）" onClick={addByFreq}>
          + Hz
        </button>
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Json ⇄ PlayNote：数据表 notes 列的结构化读写（不合规形态由调用方回落 json 编辑）
// ---------------------------------------------------------------------------

/** 单元格 Json 值 → 音符数组；结构不符返回 null（调用方回落 json 高级编辑） */
export function notesFromCell(v: unknown): PlayNote[] | null {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: PlayNote[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const midi = (item as { midi?: unknown }).midi
    const dur = (item as { dur?: unknown }).dur
    if (typeof midi !== 'number' || !Number.isFinite(midi)) return null
    if (dur !== undefined && typeof dur !== 'string') return null
    out.push({ midi: Math.round(midi), dur: typeof dur === 'string' ? dur : '4n' })
  }
  return out
}

/** 音符数组 → 单元格 Json 值 */
export function notesToCell(notes: PlayNote[]): { midi: number; dur: string }[] {
  return notes.map((n) => ({ midi: n.midi, dur: n.dur }))
}
