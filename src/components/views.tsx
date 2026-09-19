/**
 * 组件视图层：把 store 里的组件状态渲染出来，并把用户交互作为事件发回逻辑引擎。
 * 视图不包含业务判定——一切判定都在逻辑引擎的规则里（数据即关卡）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Accidental, Dot, Formatter, Renderer, Stave, StaveNote, Voice } from 'vexflow'
import { Note } from 'tonal'
import type { ComponentInstance } from '../engine/level'
import type { Json } from '../engine/expr'
import type { ButtonState, ChoiceState, FingeringState, InputState, LabelState, RhythmState, SliderState, StaffState, SynthState, TunerState } from '../runtime/componentDef'
import { SYNTH_WAVE_ZH } from '../runtime/componentDef'
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

/** MusicDoc → VexFlow 音符数组（纯函数，便于单测：音位/附点/升降号） */
export function toStaveNotes(doc: MusicDoc): StaveNote[] {
  const clef = doc.clef ?? 'treble'
  return doc.notes.map((n) => {
    const info = Note.get(Note.fromMidi(n.midi) ?? 'C4')
    // 音位由 StaveNote 自身的 clef 决定（与 Stave 上画的谱号无关），必须显式传入
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
}

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

    const staveNotes = toStaveNotes(doc)

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
      svgEl.addEventListener('click', () => {
        store.applyCommand(spec.id, '__strike', { midi })
        emit('noteClicked', { midi, name: Note.fromMidi(midi) })
      })
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
  const state = useComponentState<ButtonState & { __enabled?: boolean }>(store, spec.id)
  const { text } = state
  const enabled = state.enabled && state.__enabled !== false
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
  const state = useComponentState<ChoiceState & { __enabled?: boolean }>(store, spec.id)
  const { options } = state
  const revealed = state.revealed
  const disabled = revealed !== null || state.__enabled === false
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
            disabled={disabled}
            onClick={() => {
              if (disabled) return
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
// 合成器：音色面板 + 播放电平动画（playSeq 变化触发一轮衰减动画）
// ---------------------------------------------------------------------------

export function SynthView({ spec, store }: ViewProps) {
  const { wave, gain, lastPlay, playSeq } = useComponentState<SynthState & { __enabled?: boolean }>(store, spec.id)
  const [pulse, setPulse] = useState(false)
  const seqRef = useRef(playSeq)

  useEffect(() => {
    if (playSeq === seqRef.current) return
    seqRef.current = playSeq
    if (playSeq === 0) return
    setPulse(true)
    const timer = window.setTimeout(() => setPulse(false), 900)
    return () => window.clearTimeout(timer)
  }, [playSeq])

  const waveZh = SYNTH_WAVE_ZH[wave] ?? wave
  const notes = Array.isArray(lastPlay) ? (lastPlay as unknown as { midi: number }[]).length : 0
  const bars = [0.55, 0.85, 1, 0.7, 0.4]

  return (
    <div style={boxStyle(spec)} className={`comp-synth ${pulse ? 'is-playing' : ''}`}>
      <div className="synth-wave">{waveZh}</div>
      <div className="synth-bars" aria-hidden>
        {bars.map((h, i) => (
          <span key={i} className={`synth-bar bar-${i}`} style={{ height: `${h * 100}%` }} />
        ))}
      </div>
      <div className="synth-meta muted">{pulse ? `▶ ${notes} 音` : `音量 ${Math.round(gain * 100)}%`}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function ComponentView(props: ViewProps): React.ReactNode {
  const { spec } = props
  if (spec.visible === false) return null
  // 基座 setVisible 命令的状态位（undefined = 可见）；必须订阅 store，
  // 否则 applyCommand 后本组件不重渲染、门永不复评
  const baseState = useSyncExternalStore(props.store.subscribe, () => props.store.snapshot(spec.id)).state as
    | { __visible?: boolean }
    | null
  if (baseState?.__visible === false) return null
  switch (spec.type) {
    case 'staff':
      return <StaffView {...props} />
    case 'label':
      return <LabelView {...props} />
    case 'button':
      return <ButtonView {...props} />
    case 'choice':
      return <ChoiceView {...props} />
    case 'slider':
      return <SliderView {...props} />
    case 'input':
      return <InputView {...props} />
    case 'fingering':
      return <FingeringView {...props} />
    case 'rhythm':
      return <RhythmView {...props} />
    case 'tuner':
      return <TunerView {...props} />
    case 'synth':
      return <SynthView {...props} />
    default:
      // 未知组件类型：降级为占位框而不是崩溃（docs §7 承诺）
      return (
        <div style={boxStyle(spec)} className="comp-unknown">
          组件缺失：{spec.type}
        </div>
      )
  }
}

// ---------------------------------------------------------------------------

export function SliderView({ spec, store, emit }: ViewProps) {
  const state = useComponentState<SliderState & { __enabled?: boolean }>(store, spec.id)
  const value = state.value
  const disabled = state.__enabled === false
  const p = (spec.props ?? {}) as Record<string, Json>
  const min = typeof p.min === 'number' ? p.min : 0
  const max = typeof p.max === 'number' ? p.max : 100
  const step = typeof p.step === 'number' ? p.step : 1
  const commit = (): void => {
    emit('changed', { value })
  }
  return (
    <div style={boxStyle(spec)} className="comp-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => store.applyCommand(spec.id, '__set', { value: Number(e.target.value) })}
        onPointerUp={commit}
        onKeyUp={commit}
      />
      <span className="slider-value">{value}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------

export function InputView({ spec, store, emit }: ViewProps) {
  const state = useComponentState<InputState & { __enabled?: boolean }>(store, spec.id)
  const value = state.value
  const disabled = state.__enabled === false
  const p = (spec.props ?? {}) as Record<string, Json>
  return (
    <input
      type="text"
      style={boxStyle(spec)}
      className="comp-input"
      placeholder={typeof p.placeholder === 'string' ? p.placeholder : ''}
      value={value}
      disabled={disabled}
      onChange={(e) => store.applyCommand(spec.id, 'setValue', { value: e.target.value })}
      onKeyDown={(e) => {
        // 中文输入法组合态下按 Enter 是确认候选，不是提交
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) emit('submitted', { value })
      }}
    />
  )
}

// ---------------------------------------------------------------------------

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10])

interface KeyInfo {
  midi: number
  isBlack: boolean
}

export function FingeringView({ spec, store, emit }: ViewProps) {
  const { highlights } = useComponentState<FingeringState>(store, spec.id)
  const p = (spec.props ?? {}) as Record<string, Json>
  const low = typeof p.lowMidi === 'number' ? p.lowMidi : 48
  const high = typeof p.highMidi === 'number' ? p.highMidi : 72

  const keys: KeyInfo[] = []
  for (let midi = low; midi <= high; midi++) {
    keys.push({ midi, isBlack: BLACK_PITCH_CLASSES.has(midi % 12) })
  }
  const whites = keys.filter((k) => !k.isBlack)
  const whiteW = 100 / Math.max(1, whites.length)
  const blackW = whiteW * 0.62

  return (
    <div style={boxStyle(spec)} className="comp-fingering">
      {whites.map((k, i) => {
        const hl = highlights?.[String(k.midi)]
        return (
          <button
            key={k.midi}
            type="button"
            className={`key white ${hl ?? ''}`}
            style={{ left: `${i * whiteW}%`, width: `${whiteW}%` }}
            data-midi={k.midi}
            title={Note.fromMidi(k.midi) ?? String(k.midi)}
            onClick={() => {
              store.applyCommand(spec.id, '__strike', { midi: k.midi })
              emit('keyClicked', { midi: k.midi, name: Note.fromMidi(k.midi) })
            }}
          />
        )
      })}
      {keys
        .filter((k) => k.isBlack)
        .map((k) => {
          const whitesBefore = whites.filter((w) => w.midi < k.midi).length
          const hl = highlights?.[String(k.midi)]
          return (
            <button
              key={k.midi}
              type="button"
              className={`key black ${hl ?? ''}`}
              style={{ left: `${whitesBefore * whiteW - blackW / 2}%`, width: `${blackW}%` }}
              data-midi={k.midi}
              title={Note.fromMidi(k.midi) ?? String(k.midi)}
              onClick={() => {
                store.applyCommand(spec.id, '__strike', { midi: k.midi })
                emit('keyClicked', { midi: k.midi, name: Note.fromMidi(k.midi) })
              }}
            />
          )
        })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 节奏训练：节拍网格 + 节拍器 + tap 采集（时钟全部取自 AudioContext）
// ---------------------------------------------------------------------------

import { getCtx, playClick } from '../runtime/audio'

export function RhythmView({ spec, store, emit }: ViewProps) {
  const { running, beats, bpm, countIn, runId } = useComponentState<RhythmState>(store, spec.id)
  const [activeBeat, setActiveBeat] = useState(-1)
  const [tapped, setTapped] = useState(false)
  const timersRef = useRef<{ raf: number; end: number } | null>(null)
  const runningRef = useRef(false)
  const t0Ref = useRef(0)

  useEffect(() => {
    // runId 在 deps 中：judged.else 里"同参数重发 start"也会重建本轮排程
    if (!running || runId === 0) {
      runningRef.current = false
      if (timersRef.current) {
        cancelAnimationFrame(timersRef.current.raf)
        clearTimeout(timersRef.current.end)
        timersRef.current = null
      }
      setActiveBeat(-1)
      return
    }
    const ctx = getCtx()
    const spb = 60 / Math.max(1, bpm)
    const t0 = ctx.currentTime + countIn * spb + 0.2
    t0Ref.current = t0
    const grid = Array.from({ length: beats }, (_, i) => t0 + i * spb)
    // 预备拍 + 全部节拍一次性精排（AudioContext 时钟，不依赖定时器精度）；
    // 每个已排程 click 记录停用函数，cleanup 时静停（防换轮残响，且不误杀新一轮）
    const clickStops: Array<() => void> = []
    for (let i = 0; i < countIn; i++) clickStops.push(playClick(ctx.currentTime + 0.2 + i * spb, false))
    grid.forEach((g, i) => clickStops.push(playClick(g, i % 4 === 0)))
    runningRef.current = true

    const tick = (): void => {
      if (!runningRef.current) return
      const now = ctx.currentTime
      const beat = Math.floor((now - t0) / spb)
      setActiveBeat(beat >= 0 && beat < beats ? beat : -1)
      if (now > t0 + beats * spb + 0.5) {
        emit('roundDone', { duration: beats * spb })
        runningRef.current = false
        setActiveBeat(-1)
        return
      }
      timersRef.current = { raf: requestAnimationFrame(tick), end: 0 }
    }
    timersRef.current = { raf: requestAnimationFrame(tick), end: 0 }

    return () => {
      runningRef.current = false
      if (timersRef.current) cancelAnimationFrame(timersRef.current.raf)
      timersRef.current = null
      clickStops.forEach((stop) => stop())
    }
  }, [running, beats, bpm, countIn, runId, spec.props, emit])

  function tap(): void {
    if (!runningRef.current) return
    // 相对起拍的秒数（预备拍期间为负），与题面 grid 同一基准
    const t = getCtx().currentTime - t0Ref.current
    setTapped(true)
    setTimeout(() => setTapped(false), 120)
    emit('tap', { t })
  }

  return (
    <div style={boxStyle(spec)} className="comp-rhythm">
      <div className="beat-row">
        {Array.from({ length: beats }, (_, i) => (
          <span key={i} className={`beat-dot ${i === activeBeat ? 'active' : ''}`} />
        ))}
      </div>
      <div className={`tap-pad ${running ? 'live' : ''} ${tapped ? 'hit' : ''}`} onPointerDown={tap}>
        {running ? 'TAP' : '未开始'}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 校音器：麦克风音高流 + 表盘
// ---------------------------------------------------------------------------

import { PitchDetector } from 'pitchy'

const TUNER_CLARITY_GATE = 0.9

export function TunerView({ spec, store, emit }: ViewProps) {
  const { running } = useComponentState<TunerState>(store, spec.id)
  const [display, setDisplay] = useState<{ name: string; freq: number; cents: number; clarity: number } | null>(null)
  const [micError, setMicError] = useState('')

  useEffect(() => {
    if (!running) return
    let alive = true
    let stream: MediaStream | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    let timer: number | null = null
    ;(async () => {
      try {
        setMicError('')
        const ctx = getCtx()
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        })
        if (!alive) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        source = ctx.createMediaStreamSource(stream)
        analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        source.connect(analyser)
        const buf = new Float32Array(analyser.fftSize)
        const detector = PitchDetector.forFloat32Array(analyser.fftSize)
        timer = window.setInterval(() => {
          if (!analyser) return
          analyser.getFloatTimeDomainData(buf)
          const [freq, clarity] = detector.findPitch(buf, ctx.sampleRate)
          if (freq > 40 && clarity > TUNER_CLARITY_GATE) {
            const midi = Math.round(69 + 12 * Math.log2(freq / 440))
            const target = 440 * Math.pow(2, (midi - 69) / 12)
            const cents = Math.round(1200 * Math.log2(freq / target))
            const name = Note.fromMidi(midi) ?? String(midi)
            setDisplay({ freq, clarity, cents, name })
            emit('pitch', { freq, midi, cents, clarity })
          }
        }, 100)
      } catch (e) {
        setMicError(e instanceof Error ? e.message : String(e))
        stream?.getTracks().forEach((t) => t.stop())
      }
    })()
    return () => {
      alive = false
      if (timer !== null) window.clearInterval(timer)
      source?.disconnect()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [running])

  const cents = display?.cents ?? 0
  const inTune = display !== null && Math.abs(cents) <= 5

  return (
    <div style={boxStyle(spec)} className="comp-tuner">
      {micError ? (
        <p className="tone-error">麦克风不可用：{micError}</p>
      ) : (
        <>
          <div className={`tuner-note ${inTune ? 'ok-text' : ''}`}>{display ? display.name : '—'}</div>
          <div className="tuner-freq">{display ? `${display.freq.toFixed(1)} Hz · ${cents > 0 ? '+' : ''}${cents}¢` : '等待检测…'}</div>
          <div className="cents-bar">
            <div className="cents-tick" />
            <div className={`cents-needle ${inTune ? 'ok' : ''}`} style={{ left: `${50 + Math.max(-50, Math.min(50, cents))}%` }} />
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            {running ? '♪ 对麦克风演奏…' : '已停止'}
          </div>
        </>
      )}
    </div>
  )
}
