/**
 * 音符序列 chips 编辑器（3-7 抽取共用）：sound/synth.play 参数编辑器与数据表 notes 列
 * 单元格共用同一套交互——音名下拉（C2–C7，tonal 换算）+ 时值下拉 + 频率 Hz 换算添加 + 删除。
 * 受控组件：notes 数组进出，不含表达式语义（那是 PlayArgsEditor 的职责）。
 */
import { useState } from 'react'
import { Note } from 'tonal'
import type { Json } from '../../engine/expr'

/** 音符串元素：休止符（rest: true）无 midi；t = 起始拍（缺省接排，docs/27） */
export interface PlayNote {
  midi?: number
  dur: string
  vel?: number
  t?: number
  rest?: boolean
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
        <span key={`${n.rest ? 'r' : n.midi}-${n.dur}-${n.t ?? 'x'}-${i}`} className="play-note">
          {n.rest === true || typeof n.midi !== 'number' ? (
            <span className="play-note-rest" title="休止符（占时值不发声）">
              𝄽
            </span>
          ) : (
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
          )}
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

/** 单元格 Json 值 → 音符数组；结构不符返回 null（调用方回落 json 高级编辑）。
 * 已知键（midi/dur/vel/t/rest）完整往返，未知键拒绝（防静默丢数据） */
export function notesFromCell(v: unknown): PlayNote[] | null {
  if (v === null || v === undefined) return []
  if (!Array.isArray(v)) return null
  const out: PlayNote[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    const rec = item as Record<string, unknown>
    for (const k of Object.keys(rec)) {
      if (!['midi', 'dur', 'vel', 't', 'rest'].includes(k)) return null
    }
    const dur = rec.dur
    if (dur !== undefined && typeof dur !== 'string') return null
    const t = rec.t
    if (t !== undefined && (typeof t !== 'number' || !Number.isFinite(t))) return null
    const vel = rec.vel
    if (vel !== undefined && (typeof vel !== 'number' || !Number.isFinite(vel))) return null
    const rest = rec.rest === true
    const midi = rec.midi
    if (!rest && (typeof midi !== 'number' || !Number.isFinite(midi))) return null
    if (rest && midi !== undefined) return null
    const note: PlayNote = { dur: typeof dur === 'string' ? dur : '4n' }
    if (!rest) note.midi = Math.round(midi as number)
    if (vel !== undefined) note.vel = vel
    if (t !== undefined) note.t = t
    if (rest) note.rest = true
    out.push(note)
  }
  return out
}

/** 音符数组 → 单元格 Json 值（可选字段仅在有值时输出） */
export function notesToCell(notes: PlayNote[]): { [k: string]: Json }[] {
  return notes.map((n) => {
    const cell: { [k: string]: Json } = {}
    if (n.rest === true) cell.rest = true
    else if (typeof n.midi === 'number') cell.midi = n.midi
    cell.dur = n.dur
    if (typeof n.vel === 'number') cell.vel = n.vel
    if (typeof n.t === 'number') cell.t = n.t
    return cell
  })
}

/** 时值记法白名单（含附点），与 Note.dur 的 schema 红线一致 */
const DUR_RE = /^(1|2|4|8|16|32)n\.?$/

/**
 * 紧凑文本 → 音符数组（五线谱弹窗「从文本导入」用）：空白/逗号分隔 token，
 * 每个 token = `音名[:时值]`（如 C4、C#4:8n.、Db3）或 `MIDI号[:时值]`（如 60、62:2n）；
 * `r`/`R`/`0` = 休止符。时值缺省 4n，须为 1n–32n（含附点）。
 * 任一 token 无法解析 → 返回 null（调用方提示，不静默丢音）。
 */
export function parseNoteTokens(text: string): PlayNote[] | null {
  const tokens = text.trim().split(/[\s,，、]+/).filter((t) => t !== '')
  if (tokens.length === 0) return []
  const out: PlayNote[] = []
  for (const token of tokens) {
    const sep = token.indexOf(':')
    const pitchPart = sep === -1 ? token : token.slice(0, sep)
    const durPart = sep === -1 ? '' : token.slice(sep + 1)
    let dur = '4n'
    if (durPart !== '') {
      if (!DUR_RE.test(durPart)) return null
      dur = durPart
    }
    if (/^(r|R|0)$/.test(pitchPart)) {
      out.push({ rest: true, dur })
      continue
    }
    let midi: number | null = null
    if (/^\d+$/.test(pitchPart)) {
      midi = Number(pitchPart)
      if (midi > 127) return null
    } else {
      const m = Note.midi(pitchPart)
      if (m === null) return null
      midi = m
    }
    out.push({ midi, dur })
  }
  return out
}
