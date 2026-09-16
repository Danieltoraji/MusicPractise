/**
 * 节奏判定 demo：WebAudio lookahead 调度节拍器 + tap 采集 + rhythmMatch 判定。
 * 视觉高亮与发声都读 AudioContext.currentTime —— 单一时间基准（预研报告风险 #2）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { getCtx, playClick } from '../runtime/audio'
import { rhythmMatch, type RhythmResult } from '../engine/rhythm'

const BPM = 80
const BEATS = 8
const SPB = 60 / BPM
const COUNT_IN = 4 // 拍

type Phase = 'idle' | 'playing' | 'done'

/** 输入防御：非数字保持原值，越界 clamp */
function parseNum(raw: string, lo: number, hi: number, prev: number): number {
  const v = Number(raw)
  if (!Number.isFinite(v)) return prev
  return Math.min(hi, Math.max(lo, v))
}

export function RhythmDemo() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [activeBeat, setActiveBeat] = useState(-1)
  const [result, setResult] = useState<RhythmResult | null>(null)
  const [toleranceMs, setToleranceMs] = useState(120)
  const [latencyMs, setLatencyMs] = useState(0)

  const gridRef = useRef<number[]>([])
  const tapsRef = useRef<number[]>([])
  const schedRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const nextBeatRef = useRef(0)
  const phaseRef = useRef<Phase>('idle')

  const stopTimers = useCallback(() => {
    if (schedRef.current !== null) window.clearInterval(schedRef.current)
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    schedRef.current = null
    rafRef.current = null
  }, [])

  useEffect(() => () => stopTimers(), [stopTimers])

  const finish = useCallback(() => {
    stopTimers()
    setActiveBeat(-1)
    const corrected = tapsRef.current.map((t) => t - latencyMs / 1000)
    const r = rhythmMatch(corrected, gridRef.current, toleranceMs)
    setResult(r)
    setPhase('done')
    phaseRef.current = 'done'
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latencyMs, toleranceMs, stopTimers])

  function start(): void {
    const ctx = getCtx()
    tapsRef.current = []
    setResult(null)
    nextBeatRef.current = 0

    const t0 = ctx.currentTime + COUNT_IN * SPB + 0.2
    gridRef.current = Array.from({ length: BEATS }, (_, i) => t0 + i * SPB)

    // 预备拍
    for (let i = 0; i < COUNT_IN; i++) playClick(ctx.currentTime + 0.2 + i * SPB, false)

    // lookahead 调度（A Tale of Two Clocks 模式）
    schedRef.current = window.setInterval(() => {
      const now = ctx.currentTime
      while (nextBeatRef.current < BEATS && gridRef.current[nextBeatRef.current] < now + 0.15) {
        playClick(gridRef.current[nextBeatRef.current], nextBeatRef.current % 4 === 0)
        nextBeatRef.current++
      }
      if (now > t0 + BEATS * SPB + 0.6) finish()
    }, 25)

    // 视觉高亮读同一时钟
    const tick = (): void => {
      const now = ctx.currentTime
      const beat = Math.floor((now - t0) / SPB)
      setActiveBeat(beat >= 0 && beat < BEATS ? beat : -1)
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)

    setPhase('playing')
    phaseRef.current = 'playing'
  }

  const registerTap = useCallback(() => {
    if (phaseRef.current !== 'playing') return
    tapsRef.current.push(getCtx().currentTime)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Space') {
        e.preventDefault()
        if (e.repeat) return // 长按自动重复会灌入大量假 tap
        registerTap()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [registerTap])

  return (
    <div className="page">
      <h1>节奏判定 Demo</h1>
      <p className="muted">
        {BPM} BPM · {BEATS} 拍。空格键或点击大圆盘打拍子；预备拍后跟随节拍。判定容差与延迟校准均可调。
      </p>

      <div className="rhythm-controls">
        <label>
          容差{' '}
          <input
            type="number"
            value={toleranceMs}
            min={30}
            max={400}
            step={10}
            onChange={(e) => setToleranceMs(parseNum(e.target.value, 30, 400, toleranceMs))}
          />{' '}
          ms
        </label>
        <label>
          延迟校准{' '}
          <input
            type="number"
            value={latencyMs}
            min={-200}
            max={200}
            step={10}
            onChange={(e) => setLatencyMs(parseNum(e.target.value, -200, 200, latencyMs))}
          />{' '}
          ms
        </label>
      </div>

      <div className="beat-row">
        {Array.from({ length: BEATS }, (_, i) => (
          <span key={i} className={`beat-dot ${i === activeBeat ? 'active' : ''} ${result ? (result.hits[i] !== null ? 'hit' : 'miss') : ''}`} />
        ))}
      </div>

      {phase !== 'playing' && (
        <button type="button" className="primary" onClick={start}>
          ▶ 开始
        </button>
      )}

      <div
        className={`tap-pad ${phase === 'playing' ? 'live' : ''}`}
        onPointerDown={registerTap}
      >
        {phase === 'playing' ? '打拍子！' : 'TAP'}
      </div>

      {phase === 'playing' && <p className="muted">已记录 {tapsRef.current.length} 次 tap</p>}

      {result && phase === 'done' && (
        <div className="rhythm-result">
          <h2>得分 {Math.round(result.score * 100)}%</h2>
          <p>
            命中 {result.hits.filter((h) => h !== null).length}/{BEATS} · 多拍 {result.extraTaps.length} 次
          </p>
          {result.deltas.some((d) => d !== null) && (
            <p className="muted">
              偏差（ms）：{result.deltas.map((d) => (d === null ? '—' : Math.round(d * 1000))).join(' · ')}
            </p>
          )}
          {result.extraTaps.length > 0 && (
            <p className="muted">若整体偏移一致，试试调整「延迟校准」。</p>
          )}
        </div>
      )}
    </div>
  )
}
