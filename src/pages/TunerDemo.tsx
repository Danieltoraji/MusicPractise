/**
 * 校音器（频率计）demo：麦克风 → McLeod 音高检测（pitchy）→ 音名 + 音分偏差。
 * POC 用 AnalyserNode 采集；生产路径为 AudioWorklet 环形缓冲（见预研报告 3.5）。
 */
import { useEffect, useRef, useState } from 'react'
import { PitchDetector } from 'pitchy'
import { Note } from 'tonal'
import { getCtx } from '../runtime/audio'

interface Reading {
  freq: number
  clarity: number
  midi: number
  cents: number
  name: string
}

const CLARITY_GATE = 0.9

export function TunerDemo() {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [reading, setReading] = useState<Reading | null>(null)
  const [inTuneStreak, setInTuneStreak] = useState(0)
  const streamRef = useRef<MediaStream | null>(null)
  const nodesRef = useRef<{ source: MediaStreamAudioSourceNode; analyser: AnalyserNode } | null>(null)
  const timerRef = useRef<number | null>(null)
  const startingRef = useRef(false)

  useEffect(() => {
    return () => {
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stop(): void {
    startingRef.current = false
    if (timerRef.current !== null) window.clearInterval(timerRef.current)
    timerRef.current = null
    nodesRef.current?.source.disconnect()
    nodesRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setRunning(false)
    setReading(null)
    setInTuneStreak(0)
  }

  async function start(): Promise<void> {
    // 防重入：getUserMedia 挂起期间再点会导致流与 interval 双份泄漏
    if (startingRef.current || streamRef.current) return
    startingRef.current = true
    let stream: MediaStream | null = null
    try {
      setError('')
      const ctx = getCtx()
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      // 等待授权期间可能已被 stop/卸载
      if (!startingRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      source.connect(analyser)
      nodesRef.current = { source, analyser }

      const buf = new Float32Array(analyser.fftSize)
      const detector = PitchDetector.forFloat32Array(analyser.fftSize)
      let streak = 0

      timerRef.current = window.setInterval(() => {
        analyser.getFloatTimeDomainData(buf)
        const [freq, clarity] = detector.findPitch(buf, ctx.sampleRate)
        if (freq > 40 && clarity > CLARITY_GATE) {
          const midi = Math.round(69 + 12 * Math.log2(freq / 440))
          const target = 440 * Math.pow(2, (midi - 69) / 12)
          const cents = Math.round(1200 * Math.log2(freq / target))
          streak = Math.abs(cents) <= 5 ? streak + 1 : 0
          setReading({ freq, clarity, midi, cents, name: Note.fromMidi(midi) ?? String(midi) })
          setInTuneStreak(streak)
        } else {
          streak = 0
          setInTuneStreak(0)
        }
      }, 100)
      setRunning(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      stream?.getTracks().forEach((t) => t.stop())
    } finally {
      startingRef.current = false
    }
  }

  const cents = reading?.cents ?? 0
  const inTune = Math.abs(cents) <= 5

  return (
    <div className="page">
      <h1>校音器（频率计）Demo</h1>
      <p className="muted">对麦克风哼一个音或弹一根弦；绿色 = 音分偏差 ≤ 5。逻辑规则可用「持续稳定 N 毫秒」判定通过。</p>

      {!running ? (
        <button type="button" className="primary" onClick={() => void start()}>
          🎤 启动麦克风
        </button>
      ) : (
        <button type="button" onClick={stop}>
          停止
        </button>
      )}
      {error && <p className="tone-error">麦克风不可用：{error}</p>}

      <div className="tuner-panel">
        <div className="tuner-note">{reading ? reading.name : '—'}</div>
        <div className="tuner-freq">{reading ? `${reading.freq.toFixed(1)} Hz` : '等待检测…'}</div>
        <div className="cents-bar">
          <div className="cents-tick" />
          <div
            className={`cents-needle ${inTune ? 'ok' : ''}`}
            style={{ left: `${50 + Math.max(-50, Math.min(50, cents))}%` }}
          />
        </div>
        <div className="cents-labels">
          <span>-50¢</span>
          <span className={inTune ? 'ok-text' : ''}>{reading ? `${cents > 0 ? '+' : ''}${cents}¢` : ''}</span>
          <span>+50¢</span>
        </div>
        <div className="muted">
          信度 {(reading?.clarity ?? 0).toFixed(2)}（门限 {CLARITY_GATE}）
          {inTuneStreak > 0 && ` · 已稳定 ${inTuneStreak} × 100ms`}
        </div>
      </div>
    </div>
  )
}
