/**
 * 五线谱编辑器（docs/27 数据表全可视化）：音符串的谱面编辑与迷你预览。
 * - StaffPreview：只读单行迷你谱（数据表单元格内嵌，只显示一行后面隐藏）
 * - StaffEditorModal：弹窗编辑——时值/附点、音符/休止符、「与上一音同时」（和弦）、
 *   点谱线加音、点音符头选中改时值/升降/删除、试听播放
 * 纯函数（diatonic↔midi 换算 / 时序游标 / 增改逻辑）导出可单测。
 * 音符串时序模型：t 缺省接排（旋律），相同 t 同时响（和弦）——与运行时 scheduleNoteEvents 一致。
 */
import { useEffect, useRef, useState } from 'react'
import { Dot, Formatter, Renderer, Stave, StaveNote, Voice } from 'vexflow'
import { durToQuarters, playNotes } from '../runtime/audio'
import { DUR_OPTIONS, type PlayNote } from './graph/NoteChipsEditor'

// ---------------------------------------------------------------------------
// 纯函数：diatonic 换算与时序游标
// ---------------------------------------------------------------------------

const WHITE_SEMIS = [0, 2, 4, 5, 7, 9, 11] // C D E F G A B

/** 绝对 diatonic 序号（C0 = 0，每八度 +7）→ 白键 midi（C4=60：dn 28） */
export function dnToMidi(dn: number): number {
  const oct = Math.floor(dn / 7)
  const deg = ((dn % 7) + 7) % 7
  return (oct + 1) * 12 + WHITE_SEMIS[deg]
}

/** 白键 midi → diatonic 序号；黑键返回 -1 */
export function midiToDn(midi: number): number {
  const oct = Math.floor(midi / 12) - 1
  const deg = WHITE_SEMIS.indexOf(((midi % 12) + 12) % 12)
  return deg === -1 ? -1 : oct * 7 + deg
}

/** 最近白键（向下归属，如 C♯ → C）：♮ 按钮用 */
export function nearestWhiteBelow(midi: number): number {
  let m = midi
  while (m > 0 && midiToDn(m) === -1) m--
  return m
}

/** 每个音符的起始拍（与运行时 scheduleNoteEvents 同一游标推进：t 缺省接排） */
export function startBeats(notes: PlayNote[]): number[] {
  const out: number[] = []
  let cursor = 0
  for (const n of notes) {
    const durBeats = durToQuarters(n.dur ?? '4n')
    const hasT = typeof n.t === 'number' && Number.isFinite(n.t)
    const start = hasT ? (n.t as number) : cursor
    out.push(start)
    cursor = hasT ? Math.max(cursor, start + durBeats) : cursor + durBeats
  }
  return out
}

/** 时间轴终点（下一音的接排位置） */
export function cursorBeat(notes: PlayNote[]): number {
  const starts = startBeats(notes)
  if (starts.length === 0) return 0
  return Math.max(...startBeats(notes).map((s, i) => s + durToQuarters(notes[i].dur ?? '4n')))
}

/** 附点时值记法（'4n' + 附点 → '4n.'） */
export function withDot(dur: string, dot: boolean): string {
  return dot && !dur.endsWith('.') ? `${dur}.` : dur
}

// ---------------------------------------------------------------------------
// 谱面绘制（预览与编辑器共用）：返回每个音符元素与点击换算所需几何
// ---------------------------------------------------------------------------

const TREBLE_TOP_LINE_DN = 38 // 高音谱号顶线 = F5（dn 5*7+3）

interface DrawResult {
  noteGroups: Element[]
  topLineY: number
  halfSpacing: number
}

function drawStaff(
  el: HTMLDivElement,
  notes: PlayNote[],
  opts: { width: number; height: number; selectedIndex?: number; clickable?: boolean; onNoteClick?: (index: number) => void },
): DrawResult | null {
  el.innerHTML = ''
  const renderer = new Renderer(el, Renderer.Backends.SVG)
  renderer.resize(opts.width, opts.height)
  const rc = renderer.getContext()
  const staveWidth = opts.width - 12
  const stave = new Stave(6, Math.floor(opts.height / 2) - 40, staveWidth)
  stave.addClef('treble')
  stave.setContext(rc).draw()

  const noteGroups: StaveNote[] = notes.map((n) => {
    const dur = n.dur ?? '4n'
    const dotted = dur.endsWith('.')
    const base = dur.slice(0, dotted ? -1 : undefined)
    const vfDur = ({ '1n': 'w', '2n': 'h', '4n': 'q', '8n': '8', '16n': '16', '32n': '32' } as Record<string, string>)[base] ?? 'q'
    const sn =
      n.rest === true || typeof n.midi !== 'number'
        ? new StaveNote({ keys: ['b/4'], duration: `${vfDur}r`, clef: 'treble' })
        : new StaveNote({ keys: [midiToVexKey(n.midi)], duration: vfDur, clef: 'treble' })
    if (dotted) sn.addModifier(new Dot(), 0)
    return sn
  })

  if (noteGroups.length > 0) {
    const totalQuarters = Math.max(1, notes.reduce((sum, n) => sum + durToQuarters(n.dur ?? '4n'), 0))
    const voice = new Voice({ numBeats: Math.ceil(totalQuarters), beatValue: 4 }).setStrict(false)
    voice.addTickables(noteGroups)
    new Formatter().joinVoices([voice]).format([voice], Math.max(80, staveWidth - 140))
    voice.draw(rc, stave)
  }

  const groups = Array.from(el.querySelectorAll('svg > g.vf-stavenote')) as HTMLElement[]
  const topLineY = stave.getYForLine(0)
  const halfSpacing = stave.getSpacingBetweenLines() / 2
  if (opts.clickable && opts.onNoteClick && groups.length === notes.length) {
    groups.forEach((g, i) => {
      ;(g as HTMLElement).style.cursor = 'pointer'
      if (i === opts.selectedIndex) {
        g.querySelectorAll('.vf-notehead').forEach((head) => {
          head.setAttribute('fill', '#4f46e5')
          head.setAttribute('stroke', '#4f46e5')
        })
      }
      g.addEventListener('click', (ev) => {
        ev.stopPropagation()
        opts.onNoteClick!(i)
      })
    })
  }
  return { noteGroups: groups, topLineY, halfSpacing }
}

/** midi → VexFlow keys 记法（'c#/4'：黑键用同名义音 + 升号由音高本身决定） */
function midiToVexKey(midi: number): string {
  const names = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'] as const
  const oct = Math.floor(midi / 12) - 1
  return `${names[((midi % 12) + 12) % 12]}/${oct}`
}

// ---------------------------------------------------------------------------
// StaffPreview：数据表迷你谱（只显示一行，后面隐藏）
// ---------------------------------------------------------------------------

export function StaffPreview(props: { notes: PlayNote[]; width?: number; height?: number }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) drawStaff(ref.current, props.notes, { width: props.width ?? 210, height: props.height ?? 64 })
  }, [props.notes, props.width, props.height])
  if (props.notes.length === 0) return <span className="tstaff-empty">（空）</span>
  return <div ref={ref} className="tstaff-svg" />
}

// ---------------------------------------------------------------------------
// StaffEditorModal：五线谱弹窗编辑器（标准交互）
// ---------------------------------------------------------------------------

export function StaffEditorModal(props: {
  title: string
  value: PlayNote[]
  onCommit: (notes: PlayNote[]) => void
  onClose: () => void
}): React.ReactElement {
  const [draft, setDraft] = useState<PlayNote[]>(props.value)
  const [dur, setDur] = useState('4n')
  const [dot, setDot] = useState(false)
  const [restMode, setRestMode] = useState(false)
  const [simultaneous, setSimultaneous] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const scoreRef = useRef<HTMLDivElement>(null)
  const geometryRef = useRef<{ topLineY: number; halfSpacing: number } | null>(null)

  const width = Math.max(760, 110 + draft.length * 92 + 140)
  const effectiveDur = withDot(dur, dot)

  useEffect(() => {
    if (!scoreRef.current) return
    const res = drawStaff(scoreRef.current, draft, {
      width,
      height: 210,
      selectedIndex: selected ?? undefined,
      clickable: true,
      onNoteClick: (i) => setSelected(i === selected ? null : i),
    })
    if (res) geometryRef.current = { topLineY: res.topLineY, halfSpacing: res.halfSpacing }
  }, [draft, selected, width])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected !== null) {
        e.preventDefault()
        removeSelected()
      }
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const startBeatsOf = startBeats(draft)
  const insertAt = simultaneous && draft.length > 0 ? startBeatsOf[startBeatsOf.length - 1] : cursorBeat(draft)

  const append = (note: PlayNote): void => setDraft([...draft, note])

  /** 点击谱面：y 位置 → diatonic 音位 → 白键 midi（黑键经选中后 ♯/♭ 调整） */
  const addAtClick = (ev: React.MouseEvent): void => {
    const geo = geometryRef.current
    if (!geo || restMode) return
    const rect = (scoreRef.current as HTMLElement).getBoundingClientRect()
    const step = Math.round((geo.topLineY - (ev.clientY - rect.top)) / geo.halfSpacing)
    const midi = Math.max(0, Math.min(127, dnToMidi(TREBLE_TOP_LINE_DN + step)))
    append(restMode ? { rest: true, dur: effectiveDur, t: insertAt } : { midi, dur: effectiveDur, t: insertAt })
    setSelected(draft.length)
  }

  const appendRest = (): void => append({ rest: true, dur: effectiveDur, t: insertAt })

  const patchSelected = (patch: (n: PlayNote) => PlayNote): void => {
    if (selected === null || selected >= draft.length) return
    setDraft(draft.map((n, i) => (i === selected ? patch(n) : n)))
  }

  const removeSelected = (): void => {
    if (selected === null) return
    setDraft(draft.filter((_, i) => i !== selected))
    setSelected(null)
  }

  return (
    <div
      className="tjson-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="tjson-modal staff-modal">
        <div className="tjson-modal-head">
          <b>{props.title}</b>
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" onClick={() => props.onCommit(draft)}>
            应用
          </button>
        </div>
        <div className="staff-toolbar">
          <label>
            时值
            <select value={dur} onChange={(e) => setDur(e.target.value)}>
              {DUR_OPTIONS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label title="附点：时值 ×1.5">
            <input type="checkbox" checked={dot} onChange={(e) => setDot(e.target.checked)} /> 附点
          </label>
          <label title="添加休止符（占时值不发声）">
            <input type="checkbox" checked={restMode} onChange={(e) => setRestMode(e.target.checked)} /> 休止符模式
          </label>
          <button type="button" title="按当前时值添加休止符" onClick={appendRest}>
            + 休止符
          </button>
          <label title="新音符与前一个音同时响起（和弦）">
            <input type="checkbox" checked={simultaneous} onChange={(e) => setSimultaneous(e.target.checked)} /> 与上一音同时
          </label>
          <span className="staff-toolbar-sep" />
          {selected !== null && draft[selected] && typeof draft[selected].midi === 'number' && (
            <>
              <button type="button" title="升高半音" onClick={() => patchSelected((n) => ({ ...n, midi: Math.min(127, (n.midi as number) + 1) }))}>
                ♯
              </button>
              <button type="button" title="降低半音" onClick={() => patchSelected((n) => ({ ...n, midi: Math.max(0, (n.midi as number) - 1) }))}>
                ♭
              </button>
              <button type="button" title="还原为白键" onClick={() => patchSelected((n) => ({ ...n, midi: nearestWhiteBelow(n.midi as number) }))}>
                ♮
              </button>
              <button type="button" className="danger" title="删除选中音符" onClick={removeSelected}>
                删除
              </button>
            </>
          )}
          <button type="button" title="试听当前音符串（t/dur 时序）" onClick={() => playNotes(draft, 90)}>
            ▶ 试听
          </button>
          <button type="button" onClick={() => { setDraft([]); setSelected(null) }}>
            清空
          </button>
        </div>
        <div className="staff-editor-score" onClick={addAtClick} ref={scoreRef} />
        <p className="muted staff-editor-hint">
          点击谱线添加{restMode ? '休止符位置' : '音符'}（休止符也可用「+ 休止符」按钮）· 点击音符头选中后可改时值/升降/删除 · 时序：无 t 接排、相同 t 同时
        </p>
      </div>
    </div>
  )
}
