/**
 * 组件视图层：把 store 里的组件状态渲染出来，并把用户交互作为事件发回逻辑引擎。
 * 视图不包含业务判定——一切判定都在逻辑引擎的规则里（数据即关卡）。
 */
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Note } from 'tonal'
import type { ComponentInstance } from '../engine/level'
import type { Json } from '../engine/expr'
import type { ButtonState, ChoiceState, FingeringState, InputState, LabelState, RhythmState, SliderState, SoundState, SynthState } from '../runtime/componentDef'
import { SYNTH_WAVE_ZH } from '../runtime/componentDef'
import type { ComponentStore } from '../runtime/store'

export interface ViewProps {
  spec: ComponentInstance
  store: ComponentStore
  emit: (event: string, payload?: Json) => void
}

export function useComponentState<S = unknown>(store: ComponentStore, id: string): S {
  const snap = useSyncExternalStore(store.subscribe, () => store.snapshot(id))
  return snap.state as S
}

export function boxStyle(spec: ComponentInstance): React.CSSProperties {
  const l = spec.layout
  if (!l) return { position: 'relative' }
  return { position: 'absolute', left: l.x, top: l.y, width: l.w, height: l.h }
}

// ---------------------------------------------------------------------------

// 五线谱/校音视图按需加载（批次11 Bundle 瘦身）：VexFlow+tonal 与 pitchy 约数百 KB，
// 拆分至 staffViews.tsx / tunerView.tsx，只有关卡真的用到对应组件时才下载。
const StaffView = lazy(() => import('./staffViews').then((m) => ({ default: m.StaffView })))
const TunerView = lazy(() => import('./tunerView').then((m) => ({ default: m.TunerView })))

/** 懒视图包装：加载占位保持组件布局盒，避免面板跳动 */
function lazyView(C: React.LazyExoticComponent<React.ComponentType<ViewProps>>, props: ViewProps): React.ReactNode {
  return (
    <Suspense fallback={<div style={boxStyle(props.spec)} />}>
      <C {...props} />
    </Suspense>
  )
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
      <div className="synth-bars" aria-hidden key={playSeq}>
        {/* key=playSeq：电平条随播放重挂载，CSS 动画每次 play 都重放（评审 P2-5） */}
        {bars.map((h, i) => (
          <span key={i} className={`synth-bar bar-${i}`} style={{ height: `${h * 100}%` }} />
        ))}
      </div>
      <div className="synth-meta muted">{pulse ? `▶ ${notes} 音` : `音量 ${Math.round(gain * 100)}%`}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 发声器（sound）：采样钢琴播放面板（lastPlay 变化触发播放脉冲）
// ---------------------------------------------------------------------------

export function SoundView({ spec, store }: ViewProps) {
  const { lastPlay } = useComponentState<SoundState & { __enabled?: boolean }>(store, spec.id)
  const [pulse, setPulse] = useState(false)

  useEffect(() => {
    if (!lastPlay) return
    setPulse(true)
    const timer = window.setTimeout(() => setPulse(false), 700)
    return () => window.clearTimeout(timer)
  }, [lastPlay])

  const count = Array.isArray(lastPlay) ? (lastPlay as unknown[]).length : 0

  return (
    <div style={boxStyle(spec)} className={`comp-sound ${pulse ? 'is-playing' : ''}`}>
      <div className="sound-icon">🔊</div>
      <div className="sound-name">采样音色 · 钢琴</div>
      <div className="sound-meta muted">{pulse ? `▶ ${count} 音` : '就绪'}</div>
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
      return lazyView(StaffView, props)
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
      return lazyView(TunerView, props)
    case 'synth':
      return <SynthView {...props} />
    case 'sound':
      return <SoundView {...props} />
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
  // 滑奏（批次12）：按住拖划经过的键依次发声——PC 鼠标与触屏同一 pointer 通道。
  // movedRef 抑制滑奏松手时浏览器对起始键补发的 click（避免重复发声）
  const glideRef = useRef<{ pointerId: number; lastMidi: number | null } | null>(null)
  const movedRef = useRef(false)

  const strike = (midi: number): void => {
    store.applyCommand(spec.id, '__strike', { midi })
    emit('keyClicked', { midi, name: Note.fromMidi(midi) })
  }

  const onGlideMove = (e: React.PointerEvent): void => {
    const glide = glideRef.current
    if (!glide || e.pointerId !== glide.pointerId) return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const key = el instanceof Element ? el.closest<HTMLElement>('[data-midi]') : null
    const midi = key ? Number(key.dataset.midi) : NaN
    if (!Number.isFinite(midi) || midi === glide.lastMidi) return
    glide.lastMidi = midi
    movedRef.current = true
    strike(midi)
  }

  const endGlide = (e: React.PointerEvent): void => {
    if (glideRef.current?.pointerId !== e.pointerId) return
    glideRef.current = null
    // click 补发发生在 pointerup 之后：延迟一拍复位，让键的 onClick 跳过这一次
    setTimeout(() => {
      movedRef.current = false
    }, 0)
  }

  const keys: KeyInfo[] = []
  for (let midi = low; midi <= high; midi++) {
    keys.push({ midi, isBlack: BLACK_PITCH_CLASSES.has(midi % 12) })
  }
  const whites = keys.filter((k) => !k.isBlack)
  const whiteW = 100 / Math.max(1, whites.length)
  const blackW = whiteW * 0.62

  return (
    <div
      style={boxStyle(spec)}
      className="comp-fingering"
      onPointerDown={(e) => {
        if (!e.isPrimary || glideRef.current) return
        glideRef.current = { pointerId: e.pointerId, lastMidi: null }
        // 按下瞬间即发声（钢琴语义；桌面点击从「松手响」变「按下响」），
        // 该键的 click 由 movedRef 抑制——发声权已归 pointerdown
        movedRef.current = true
        const key = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-midi]') : null
        const midi = key ? Number(key.dataset.midi) : NaN
        if (Number.isFinite(midi)) {
          glideRef.current.lastMidi = midi
          strike(midi)
        }
      }}
      onPointerMove={onGlideMove}
      onPointerUp={endGlide}
      onPointerCancel={endGlide}
    >
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
              if (movedRef.current) return // 滑奏松手：起始键的补发 click 抑制
              strike(k.midi)
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
                if (movedRef.current) return
                strike(k.midi)
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
// 校音器视图已拆分至 tunerView.tsx（批次11：pitchy 按需加载）
// ---------------------------------------------------------------------------
