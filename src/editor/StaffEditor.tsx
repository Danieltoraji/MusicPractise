/**
 * 五线谱编辑器（docs/27 数据表全可视化）：音符串的谱面编辑与迷你预览。
 * - StaffPreview：只读单行迷你谱（fitWidth 等比缩小——一行显示全部音符，超出部分不再隐藏）
 * - StaffEditorModal：弹窗编辑，MuseScore 风格输入体验——
 *     音名键 C–G 输入音符（Shift+音名 = 与上一音同时）、0 = 休止符、1–6 = 时值、. = 附点、
 *     ↑↓ = 上/下一音级、+/- = 升/降半音、←→ = 移动光标、Backspace/Delete = 删除、Space = 试听；
 *     输入光标（竖线）显示在谱面上，点击音符头选中、点击谱线在光标处按 y 音高加音。
 * 纯函数（diatonic↔midi 换算 / 时序游标 / 音高步进）导出可单测。
 * 音符串时序模型：t 缺省接排（旋律），相同 t 同时响（和弦）——与运行时 scheduleNoteEvents 一致。
 */
import { useEffect, useRef, useState } from 'react'
import { Dot, Formatter, Renderer, Stave, StaveNote, Voice } from 'vexflow'
import { durToQuarters, playNotes } from '../runtime/audio'
import { DUR_OPTIONS, parseNoteTokens, type PlayNote } from './graph/NoteChipsEditor'

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

/** 音名键 → midi（八度沿用参考音；如 refMidi=64 输入 'c' → C5？不——同八度 C5=72 时 C4=60 需就近：取与参考音最近的同名白键） */
export function whiteMidiFromLetter(letter: string, refMidi: number): number {
  const semis = WHITE_SEMIS[('cdefgab'.indexOf(letter))]
  // 同八度候选与上一个八度候选，取与参考音距离最近者（跨 B→C 自然换八度）
  const oct = Math.floor(refMidi / 12) - 1
  const candidates = [(oct + 1) * 12 + semis, (oct + 2) * 12 + semis, oct * 12 + semis]
  return Math.round(candidates.reduce((best, m) => (Math.abs(m - refMidi) < Math.abs(best - refMidi) ? m : best)))
}

/** 音高步进：↑/↓ 走 diatonic 音级（黑键 ↑ 进到上白键、↓ 退回本位白键） */
export function stepDiatonic(midi: number, dir: 1 | -1): number {
  const dn = midiToDn(midi)
  if (dn === -1) {
    // 黑键：↑ 进到上方白键，↓ 退回本位白键
    const white = midiToDn(nearestWhiteBelow(midi))
    return dir === 1 ? dnToMidi(white + 1) : dnToMidi(white)
  }
  return dnToMidi(dn + dir)
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
  return Math.max(...starts.map((s, i) => s + durToQuarters(notes[i].dur ?? '4n')))
}

/** 附点时值记法（'4n' + 附点 → '4n.'） */
export function withDot(dur: string, dot: boolean): string {
  return dot && !dur.endsWith('.') ? `${dur}.` : dur
}

// ---------------------------------------------------------------------------
// 谱面绘制（预览与编辑器共用）
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
  opts: {
    width: number
    height: number
    /** 等比缩放目标宽：内容自然宽超过它时用 viewBox 缩小（迷你谱一行显示全部音符） */
    fitWidth?: number
    selectedIndex?: number
    /** 输入光标（竖线）：显示在音符 cursorIndex 之前（= 长度时在末尾） */
    cursorIndex?: number | null
    clickable?: boolean
    onNoteClick?: (index: number) => void
  },
): DrawResult | null {
  // 自然宽度：按音符数给足最小间距（保证每个音符完整可读），预览超宽时再整体缩小
  const naturalWidth = Math.max(opts.width, 130 + notes.length * 48 + 90)
  el.innerHTML = ''
  const renderer = new Renderer(el, Renderer.Backends.SVG)
  renderer.resize(naturalWidth, opts.height)
  const rc = renderer.getContext()
  const staveWidth = naturalWidth - 12
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

  const groups = Array.from(el.querySelectorAll('svg > g.vf-stavenote')) as unknown as SVGGraphicsElement[]
  const topLineY = stave.getYForLine(0)
  const halfSpacing = stave.getSpacingBetweenLines() / 2
  const svg = el.querySelector('svg')

  if (opts.clickable && opts.onNoteClick && groups.length === notes.length) {
    groups.forEach((g, i) => {
      ;(g as unknown as HTMLElement).style.cursor = 'pointer'
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

  // 输入光标：竖线画在光标音符之前（末尾光标在最后音符右侧）。
  // jsdom 无 getBBox：拿不到几何时回落到谱面起始位置（光标仍可见，测试不炸）
  if (svg && opts.cursorIndex !== undefined && opts.cursorIndex !== null) {
    const bboxOf = (i: number): DOMRect | null => {
      const g = groups[i] as SVGGraphicsElement | undefined
      if (!g || typeof g.getBBox !== 'function') return null
      try {
        return g.getBBox()
      } catch {
        return null
      }
    }
    const startX = typeof stave.getNoteStartX === 'function' ? stave.getNoteStartX() : 60
    let x: number
    if (groups.length === 0) x = startX
    else {
      const cur = opts.cursorIndex < groups.length ? bboxOf(opts.cursorIndex) : null
      if (cur) x = cur.x - 10
      else {
        const last = bboxOf(groups.length - 1)
        x = last ? last.x + last.width + 18 : startX
      }
    }
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
    line.setAttribute('x1', String(x))
    line.setAttribute('x2', String(x))
    line.setAttribute('y1', String(stave.getYForLine(-1.5)))
    line.setAttribute('y2', String(stave.getYForLine(5.5)))
    line.setAttribute('stroke', '#4f46e5')
    line.setAttribute('stroke-width', '2')
    svg.appendChild(line)
  }

  // fitWidth：内容超宽时整体等比缩小（viewBox），迷你谱一行显示全部音符。
  // VexFlow 5 的 resize 会写内联 style.width/height——必须同步覆盖（仅改属性会被 style 压住）
  if (svg && opts.fitWidth !== undefined && naturalWidth > opts.fitWidth) {
    svg.setAttribute('viewBox', `0 0 ${naturalWidth} ${opts.height}`)
    const scaledHeight = Math.round((opts.height * opts.fitWidth) / naturalWidth)
    svg.setAttribute('width', String(opts.fitWidth))
    svg.setAttribute('height', String(scaledHeight))
    svg.style.width = `${opts.fitWidth}px`
    svg.style.height = `${scaledHeight}px`
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
// StaffPreview：数据表迷你谱（fitWidth 等比缩小，一行显示全部音符）
// ---------------------------------------------------------------------------

export function StaffPreview(props: { notes: PlayNote[]; width?: number; height?: number }): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) {
      drawStaff(ref.current, props.notes, {
        width: props.width ?? 210,
        height: props.height ?? 64,
        fitWidth: props.width ?? 210,
      })
    }
  }, [props.notes, props.width, props.height])
  if (props.notes.length === 0) return <span className="tstaff-empty">（空）</span>
  return <div ref={ref} className="tstaff-svg" />
}

// ---------------------------------------------------------------------------
// StaffEditorModal：五线谱弹窗编辑器（MuseScore 风格输入）
// ---------------------------------------------------------------------------

export function StaffEditorModal(props: {
  title: string
  value: PlayNote[]
  /** 单元格原始值（非标准音符数组时的修复通道：弹窗顶部提示 + 从文本导入，应用后替换） */
  importRaw?: unknown
  onCommit: (notes: PlayNote[]) => void
  onClose: () => void
}): React.ReactElement {
  const [draft, setDraft] = useState<PlayNote[]>(props.value)
  const [importText, setImportText] = useState('')
  const [importErr, setImportErr] = useState('')
  const [dur, setDur] = useState('4n')
  const [dot, setDot] = useState(false)
  const [restMode, setRestMode] = useState(false)
  const [simultaneous, setSimultaneous] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [cursorIndex, setCursorIndex] = useState<number>(props.value.length)
  // 键盘流以 ref 为主真源：原生同步派发的连续 keydown 之间 React 尚未重渲染，
  // 闭包里的 state 是旧值——连续输入 C-D-E-F-G 会互相覆盖。ref 同步读写，setState 仅触发渲染。
  const draftRef = useRef(draft)
  const cursorRef = useRef(cursorIndex)
  const selectedRef = useRef<number | null>(null)
  const durRef = useRef(dur)
  const dotRef = useRef(dot)
  const restModeRef = useRef(restMode)
  const simultaneousRef = useRef(simultaneous)
  const scoreRef = useRef<HTMLDivElement>(null)
  const geometryRef = useRef<{ topLineY: number; halfSpacing: number } | null>(null)
  // 最近一次涉及/插入的音高（音名键输入沿用其八度）
  const lastPitchRef = useRef<number>(64)

  const effectiveDur = withDot(durRef.current, dotRef.current)

  useEffect(() => {
    if (!scoreRef.current) return
    const w = Math.max(900, 130 + draftRef.current.length * 48 + 160)
    const res = drawStaff(scoreRef.current, draftRef.current, {
      width: w,
      height: 210,
      selectedIndex: selected ?? undefined,
      cursorIndex,
      clickable: true,
      onNoteClick: (i) => {
        commit(draftRef.current, i + 1, i)
      },
    })
    if (res) geometryRef.current = { topLineY: res.topLineY, halfSpacing: res.halfSpacing }
  }, [draft, selected, cursorIndex])

  /** 以 ref 为主真源的统一变更入口：同步 ref → setState 触发渲染（连续同步 keydown 不丢输入） */
  const commit = (next: PlayNote[], nextCursor: number, nextSelected: number | null): void => {
    draftRef.current = next
    cursorRef.current = Math.max(0, Math.min(nextCursor, next.length))
    selectedRef.current = nextSelected
    setDraft(next)
    setCursorIndex(cursorRef.current)
    setSelected(nextSelected)
  }

  /** 光标处的时间拍（「与上一音同时」勾选时取前一音起始拍） */
  const plainBeatAtCursor = (): number => {
    const prev = draftRef.current
    const ci = Math.min(cursorRef.current, prev.length)
    const bs = startBeats(prev)
    return Math.max(0, ci < prev.length ? bs[ci] : cursorBeat(prev))
  }
  const beatAtCursor = (): number =>
    simultaneousRef.current && cursorRef.current > 0 ? startBeats(draftRef.current)[cursorRef.current - 1] : plainBeatAtCursor()

  const insert = (note: PlayNote): void => {
    const prev = draftRef.current
    const ci = Math.min(cursorRef.current, prev.length)
    const next = [...prev.slice(0, ci), note, ...prev.slice(ci)]
    commit(next, ci + 1, ci)
    if (typeof note.midi === 'number') lastPitchRef.current = note.midi
  }

  const insertPitch = (letter: string, chord: boolean): void => {
    const midi = whiteMidiFromLetter(letter, lastPitchRef.current)
    const t = chord && cursorRef.current > 0 ? startBeats(draftRef.current)[cursorRef.current - 1] : beatAtCursor()
    insert({ midi, dur: effectiveDur, t: Math.max(0, t) })
  }

  const insertRest = (): void => insert({ rest: true, dur: effectiveDur, t: plainBeatAtCursor() })

  const patchAt = (index: number, patch: (n: PlayNote) => PlayNote): void => {
    const prev = draftRef.current
    if (index < 0 || index >= prev.length) return
    const next = prev.map((n, i) => (i === index ? patch(n) : n))
    const patched = patch(prev[index])
    if (typeof patched.midi === 'number') lastPitchRef.current = patched.midi
    commit(next, cursorRef.current, selectedRef.current)
  }

  const stepPitch = (dir: 1 | -1): void => {
    const index = selectedRef.current ?? cursorRef.current - 1
    const n = draftRef.current[index]
    if (!n || n.rest === true || typeof n.midi !== 'number') return
    patchAt(index, (x) => ({ ...x, midi: Math.max(0, Math.min(127, stepDiatonic(x.midi as number, dir))) }))
  }

  const halfStep = (dir: 1 | -1): void => {
    const index = selectedRef.current ?? cursorRef.current - 1
    const n = draftRef.current[index]
    if (!n || n.rest === true || typeof n.midi !== 'number') return
    patchAt(index, (x) => ({ ...x, midi: Math.max(0, Math.min(127, (x.midi as number) + dir)) }))
  }

  const setDurAt = (d: string): void => {
    if (selectedRef.current !== null) patchAt(selectedRef.current, (n) => ({ ...n, dur: d }))
    else {
      durRef.current = d
      setDur(d)
    }
  }

  const toggleDotAt = (): void => {
    if (selectedRef.current !== null) {
      patchAt(selectedRef.current, (x) => ({ ...x, dur: x.dur.endsWith('.') ? x.dur.slice(0, -1) : `${x.dur}.` }))
    } else {
      dotRef.current = !dotRef.current
      setDot(dotRef.current)
    }
  }

  const removeAt = (index: number): void => {
    const prev = draftRef.current
    if (index < 0 || index >= prev.length) return
    const next = prev.filter((_, i) => i !== index)
    const ci = cursorRef.current
    commit(next, ci > index ? ci - 1 : ci, null)
  }

  /** 点击谱面：y 位置 → diatonic 音位 → 白键 midi，在光标处插入（休止符模式加占位休止） */
  const addAtClick = (ev: React.MouseEvent): void => {
    const geo = geometryRef.current
    if (!geo) return
    const rect = (scoreRef.current as HTMLElement).getBoundingClientRect()
    const step = Math.round((geo.topLineY - (ev.clientY - rect.top)) / geo.halfSpacing)
    const midi = Math.max(0, Math.min(127, dnToMidi(TREBLE_TOP_LINE_DN + step)))
    if (restModeRef.current) insert({ rest: true, dur: effectiveDur, t: plainBeatAtCursor() })
    else {
      insert({ midi, dur: effectiveDur, t: plainBeatAtCursor() })
      lastPitchRef.current = midi
    }
  }

  /** 从紧凑文本导入音符串：解析成功替换整个谱面草稿，失败保留原内容并提示 */
  const doImport = (): void => {
    const parsed = parseNoteTokens(importText)
    if (parsed === null) {
      setImportErr('无法解析——请检查记法（音名或 MIDI 号，可带 :时值；r = 休止符）')
      return
    }
    setImportErr('')
    commit(parsed, parsed.length, null)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const k = e.key
      if (k === 'Escape') {
        props.onClose()
        return
      }
      // 时值快捷键（MuseScore：1=全音符 … 6=三十二分）；选中音符时改其时值
      const durKeys: Record<string, string> = { '1': '1n', '2': '2n', '3': '4n', '4': '8n', '5': '16n', '6': '32n' }
      if (durKeys[k] !== undefined) {
        e.preventDefault()
        setDurAt(durKeys[k])
        return
      }
      if (k === '.') {
        e.preventDefault()
        toggleDotAt()
        return
      }
      if (k === '0') {
        e.preventDefault()
        insertRest()
        return
      }
      if (/^[a-gA-G]$/.test(k)) {
        e.preventDefault()
        insertPitch(k.toLowerCase(), e.shiftKey)
        return
      }
      if (k === 'ArrowUp') {
        e.preventDefault()
        stepPitch(1)
        return
      }
      if (k === 'ArrowDown') {
        e.preventDefault()
        stepPitch(-1)
        return
      }
      if (k === '+' || k === '=') {
        e.preventDefault()
        halfStep(1)
        return
      }
      if (k === '-' || k === '_') {
        e.preventDefault()
        halfStep(-1)
        return
      }
      if (k === 'ArrowRight') {
        e.preventDefault()
        commit(draftRef.current, cursorRef.current + 1, selectedRef.current)
        return
      }
      if (k === 'ArrowLeft') {
        e.preventDefault()
        const next = Math.max(0, cursorRef.current - 1)
        commit(draftRef.current, next, next > 0 ? next - 1 : null)
        return
      }
      if (k === 'Backspace') {
        e.preventDefault()
        removeAt(cursorRef.current - 1)
        return
      }
      if (k === 'Delete') {
        e.preventDefault()
        removeAt(selectedRef.current ?? cursorRef.current)
        return
      }
      if (k === ' ') {
        e.preventDefault()
        playNotes(draftRef.current, 90)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

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
        {props.importRaw !== undefined && (
          <div className="staff-import-warn">
            当前单元格数据不是标准音符数组（应用后将替换为下方谱面内容）。原始值：
            <code>{JSON.stringify(props.importRaw)}</code>
          </div>
        )}
        <details className="staff-import">
          <summary>从文本导入（快速录入/粘贴旋律）</summary>
          <div className="staff-import-row">
            <input
              value={importText}
              placeholder="如：C4 C4 E4 G4:2n. r:4n 62:8n（空格/逗号分隔，音名或 MIDI 号，可带 :时值）"
              onChange={(e) => {
                setImportText(e.target.value)
                setImportErr('')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  doImport()
                }
              }}
            />
            <button type="button" onClick={doImport}>
              导入
            </button>
          </div>
          {importErr && <div className="tone-error">{importErr}</div>}
          <p className="muted">记法：C4 / C#4 / Db3 / 60 = 音高；后接 :1n–32n（可带附点 .）= 时值，缺省 4n；r / 0 = 休止符。</p>
        </details>
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
          <button type="button" title="按当前时值添加休止符（快捷键 0）" onClick={insertRest}>
            + 休止符
          </button>
          <label title="新音符与前一个音同时响起（和弦）；输入时按住 Shift 等效">
            <input type="checkbox" checked={simultaneous} onChange={(e) => setSimultaneous(e.target.checked)} /> 与上一音同时
          </label>
          <span className="staff-toolbar-sep" />
          {selected !== null && draft[selected] && typeof draft[selected].midi === 'number' && (
            <>
              <button type="button" title="升高半音（+）" onClick={() => halfStep(1)}>
                ♯
              </button>
              <button type="button" title="降低半音（-）" onClick={() => halfStep(-1)}>
                ♭
              </button>
              <button type="button" title="还原为白键" onClick={() => patchAt(selected, (n) => ({ ...n, midi: nearestWhiteBelow(n.midi as number) }))}>
                ♮
              </button>
              <button type="button" className="danger" title="删除选中音符（Delete）" onClick={() => removeAt(selected)}>
                删除
              </button>
            </>
          )}
          <button type="button" title="试听当前音符串（Space）" onClick={() => playNotes(draft, 90)}>
            ▶ 试听
          </button>
          <button type="button" onClick={() => commit([], 0, null)}>
            清空
          </button>
        </div>
        <div className="staff-editor-score" onClick={addAtClick} ref={scoreRef} />
        <p className="muted staff-editor-hint">
          键盘输入（MuseScore 风格）：C–G = 音符（Shift+C–G = 与上一音同时）· 0 = 休止符 · 1–6 = 时值 · . = 附点 · ↑↓ = 上/下一音级 · +/- = 升/降半音 · ←→ = 移动光标 · Backspace/Delete = 删除 · Space = 试听；也可点击谱线加音、点击音符头选中
        </p>
      </div>
    </div>
  )
}
