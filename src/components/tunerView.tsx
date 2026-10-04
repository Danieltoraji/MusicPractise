/**
 * 校音器组件视图（批次11 Bundle 瘦身拆分）：pitchy FFT 音高检测按需加载。
 */
import { useEffect, useState } from 'react'
import { PitchDetector } from 'pitchy'
import { Note } from 'tonal'
import type { TunerState } from '../runtime/componentDef'
import { getCtx } from '../runtime/audio'
import { boxStyle, useComponentState, type ViewProps } from './views'

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
