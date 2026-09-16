/**
 * 组件视图层：把 store 里的组件状态渲染出来，并把用户交互作为事件发回逻辑引擎。
 * 视图不包含业务判定——一切判定都在逻辑引擎的规则里（数据即关卡）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Accidental, Dot, Formatter, Renderer, Stave, StaveNote, Voice } from 'vexflow'
import { Note } from 'tonal'
import type { ComponentInstance } from '../engine/level'
import type { Json } from '../engine/expr'
import type { ButtonState, ChoiceState, LabelState, StaffState } from '../runtime/componentDef'
import type { ComponentStore } from '../runtime/store'
import type { MusicDoc } from '../engine/level'

export interface ViewProps {
  spec: ComponentInstance
  store: ComponentStore
  emit: (event: string, payload?: Json) => void
}

export function useComponentState<S = unknown>(store: ComponentStore, id: string): S {
  const snap = useSyncExternalStore(store.subscribe, () => store.snapshot(id))
  return snap.state as S
}

function boxStyle(spec: ComponentInstance): React.CSSProperties {
  const l = spec.layout
  if (!l) return { position: 'relative' }
  return { position: 'absolute', left: l.x, top: l.y, width: l.w, height: l.h }
}

// ---------------------------------------------------------------------------

const DUR_MAP: Record<string, string> = { '1n': 'w', '2n': 'h', '4n': 'q', '8n': '8', '16n': '16', '32n': '32' }
const HIGHLIGHT_FILL: Record<string, string> = { correct: '#16a34a', wrong: '#dc2626' }

export function StaffView({ spec, store, emit }: ViewProps) {
  const { music, highlights, clearToken } = useComponentState<StaffState>(store, spec.id)
  const containerRef = useRef<HTMLDivElement>(null)
  const clickable = ((spec.props ?? {}) as Record<string, Json>).clickable !== false

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.innerHTML = ''
    if (!music || !Array.isArray((music as { notes?: unknown }).notes)) return
    const doc = music as unknown as MusicDoc
    const w = spec.layout?.w ?? 720
    const h = spec.layout?.h ?? 160

    const renderer = new Renderer(el, Renderer.Backends.SVG)
    renderer.resize(w, h)
    const rc = renderer.getContext()
    const stave = new Stave(10, Math.max(10, h / 2 - 50), w - 30)
    stave.addClef(doc.clef ?? 'treble')
    if (doc.timeSig) stave.addTimeSignature(`${doc.timeSig[0]}/${doc.timeSig[1]}`)
    stave.setContext(rc).draw()

    const staveNotes = doc.notes.map((n) => {
      const name = Note.fromMidi(n.midi) ?? 'C4'
      const info = Note.get(name)
      // 音位由 StaveNote 自身的 clef 决定（与 Stave 上画的谱号无关），必须显式传入
      const clef = doc.clef ?? 'treble'
      const dur = n.dur ?? '4n'
      const dotted = dur.endsWith('.')
      const sn = new StaveNote({
        keys: [`${info.letter.toLowerCase()}${info.acc ?? ''}/${info.oct}`],
        duration: DUR_MAP[dotted ? dur.slice(0, -1) : dur] ?? 'q',
        clef,
      })
      if (info.acc) sn.addModifier(new Accidental(info.acc), 0)
      if (dotted) sn.addModifier(new Dot(), 0)
      return sn
    })

    const voice = new Voice({ numBeats: Math.max(1, staveNotes.length), beatValue: 4 }).setStrict(false)
    voice.addTickables(staveNotes)
    new Formatter().joinVoices([voice]).format([voice], Math.max(120, w - 120))
    voice.draw(rc, stave)

    // 命中区域：VexFlow 5 不再暴露 attrs.el；voice.draw 按顺序把每个音符画成
    // SVG 根下的 g.vf-stavenote，用 DOM 顺序与 notes[] 对齐（v1 仅支持单声部）。
    const noteGroups = el.querySelectorAll('svg > g.vf-stavenote')
    noteGroups.forEach((svgEl, i) => {
      const midi = doc.notes[i]?.midi
      if (!svgEl || typeof midi !== 'number') return
      svgEl.setAttribute('data-midi', String(midi))
      if (!clickable) return
      ;(svgEl as HTMLElement).style.cursor = 'pointer'
      svgEl.addEventListener('click', () => emit('noteClicked', { midi, name: Note.fromMidi(midi) }))
    })

    // 高亮样式
    for (const [midiStr, style] of Object.entries(highlights ?? {})) {
      const fill = HIGHLIGHT_FILL[style] ?? '#f59e0b'
      noteGroups.forEach((svgEl, i) => {
        if (doc.notes[i]?.midi !== Number(midiStr)) return
        svgEl.querySelectorAll('.vf-notehead').forEach((head) => {
          head.setAttribute('fill', fill)
          head.setAttribute('stroke', fill)
        })
      })
    }
  }, [music, highlights, clearToken, spec.layout?.w, spec.layout?.h, clickable, emit])

  return <div ref={containerRef} style={boxStyle(spec)} className="comp-staff" />
}

// ---------------------------------------------------------------------------

export function LabelView({ spec, store }: ViewProps) {
  const { text, tone } = useComponentState<LabelState>(store, spec.id)
  return (
    <div style={boxStyle(spec)} className={`comp-label tone-${tone}`}>
      {text}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function ButtonView({ spec, store, emit }: ViewProps) {
  const { text, enabled } = useComponentState<ButtonState>(store, spec.id)
  return (
    <button
      type="button"
      style={boxStyle(spec)}
      className={`comp-button ${enabled ? '' : 'is-disabled'}`}
      disabled={!enabled}
      onClick={() => {
        if (enabled) emit('clicked')
      }}
    >
      {text}
    </button>
  )
}

// ---------------------------------------------------------------------------

export function ChoiceView({ spec, store, emit }: ViewProps) {
  const { options, revealed } = useComponentState<ChoiceState>(store, spec.id)
  const [selected, setSelected] = useState<number | null>(null)

  // 换题（options 变化）时清除本地点选
  useEffect(() => {
    setSelected(null)
  }, [options])

  return (
    <div style={boxStyle(spec)} className="comp-choice">
      {options.map((opt, i) => {
        let cls = 'choice-item'
        if (revealed !== null && i === revealed) cls += ' is-correct'
        else if (revealed !== null && i === selected) cls += ' is-wrong'
        return (
          <button
            key={`${i}-${opt}`}
            type="button"
            className={cls}
            disabled={revealed !== null}
            onClick={() => {
              if (revealed !== null) return
              setSelected(i)
              emit('chosen', { index: i, value: opt })
            }}
          >
            <span className="choice-index">{String.fromCharCode(65 + (i % 26))}</span>
            {opt}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function ComponentView(props: ViewProps): React.ReactNode {
  const { spec } = props
  if (spec.visible === false) return null
  switch (spec.type) {
    case 'staff':
      return <StaffView {...props} />
    case 'label':
      return <LabelView {...props} />
    case 'button':
      return <ButtonView {...props} />
    case 'choice':
      return <ChoiceView {...props} />
    default:
      // 未知组件类型：降级为占位框而不是崩溃（docs §7 承诺）
      return (
        <div style={boxStyle(spec)} className="comp-unknown">
          组件缺失：{spec.type}
        </div>
      )
  }
}
